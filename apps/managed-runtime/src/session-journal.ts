import type { RemoteSessionCommand, RemoteSessionEvent } from "@jingler/core"

export const MAX_COMMANDS = 256
export const MAX_EVENTS_PER_COMMAND = 4_096

export interface ManagedSessionJournalState {
  readonly commands: Readonly<
    Record<
      string,
      {
        readonly command: RemoteSessionCommand
        readonly status: "running" | "complete" | "failed" | "cancelled"
        readonly events: readonly RemoteSessionEvent[]
      }
    >
  >
}

export const emptyManagedSessionJournal = (): ManagedSessionJournalState => ({
  commands: {}
})

/** Durable, idempotent command/event boundary shared by runtime fetches and tests. */
export class ManagedSessionJournal {
  #state: ManagedSessionJournalState

  constructor(restored = emptyManagedSessionJournal()) {
    this.#state = restored
  }

  snapshot(): ManagedSessionJournalState {
    return this.#state
  }

  admit(command: RemoteSessionCommand): "started" | "replay" {
    const previous = this.#state.commands[command.commandId]
    if (previous !== undefined) {
      if (JSON.stringify(previous.command) !== JSON.stringify(command)) {
        throw new Error("Command id conflicts with its durable admission")
      }
      return "replay"
    }
    if (Object.keys(this.#state.commands).length >= MAX_COMMANDS) {
      throw new Error("Managed session command retention is full")
    }
    this.#state = {
      commands: {
        ...this.#state.commands,
        [command.commandId]: { command, status: "running", events: [] }
      }
    }
    return "started"
  }

  append(
    commandId: string,
    event: Omit<RemoteSessionEvent, "version" | "commandId" | "sessionId" | "eventSequence">
  ): RemoteSessionEvent {
    const entry = this.#state.commands[commandId]
    if (entry === undefined || entry.status !== "running") {
      throw new Error("Command is not running")
    }
    if (entry.events.length >= MAX_EVENTS_PER_COMMAND) {
      throw new Error("Managed session event retention is full")
    }
    const value: RemoteSessionEvent = {
      version: 1,
      commandId,
      sessionId: entry.command.sessionId,
      eventSequence: entry.events.length,
      ...event
    }
    this.#state = {
      commands: {
        ...this.#state.commands,
        [commandId]: { ...entry, events: [...entry.events, value] }
      }
    }
    return value
  }

  settle(
    commandId: string,
    status: "complete" | "failed" | "cancelled",
    payload: unknown
  ): RemoteSessionEvent {
    const kind = status === "complete" ? "complete" : "failed"
    const terminal = this.append(commandId, { kind, payload })
    const entry = this.#state.commands[commandId]
    if (entry === undefined) throw new Error("Command disappeared during settlement")
    this.#state = {
      commands: {
        ...this.#state.commands,
        [commandId]: { ...entry, status }
      }
    }
    return terminal
  }

  replay(commandId: string, afterSequence = -1): readonly RemoteSessionEvent[] {
    return (
      this.#state.commands[commandId]?.events.filter(
        (event) => event.eventSequence > afterSequence
      ) ?? []
    )
  }
}
