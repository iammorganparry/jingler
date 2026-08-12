import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { EncryptedTunnelEnvelope, RemoteSessionCommand, RemoteSessionEvent } from "@jingler/core"

export interface ControllerExecutionScope {
  readonly clientInstanceId: string
  readonly attachmentGeneration: number
  readonly controllerLeaseGeneration: number
}

interface PersistedCommand {
  readonly command: RemoteSessionCommand
  readonly receivedSequence?: number
  readonly controllerScope?: ControllerExecutionScope
  readonly status: "admitted" | "complete" | "failed"
  /** Cleared once ciphertext has been persisted, avoiding duplicate plaintext history. */
  readonly events: ReadonlyArray<RemoteSessionEvent>
  readonly outgoingEnvelopes?: ReadonlyArray<EncryptedTunnelEnvelope>
}

interface Ledger {
  readonly version: 1
  readonly commands: Record<string, PersistedCommand>
  controllerScope?: ControllerExecutionScope
  transport: {
    readonly nextOutgoingSequence: number
    /** Contiguous desktop commands whose response ciphertext is durable. */
    readonly acknowledgedDesktopSequence: number
    /** Highest desktop sequence admitted, including commands still running. */
    readonly highestReceivedDesktopSequence: number
    /** Device response sequence confirmed consumed by the desktop. */
    readonly acknowledgedOutgoingSequence: number
  }
}

export interface SessionCommandExecutor {
  readonly execute: (
    command: RemoteSessionCommand,
    emit: (event: Omit<RemoteSessionEvent, "version" | "commandId" | "sessionId" | "eventSequence">) => Promise<void>
  ) => Promise<unknown>
}

export interface SessionCommandHandlerPolicy {
  /** Backpressure bound for responses the desktop has not acknowledged yet. */
  readonly maxRetainedCommands: number
  /** Includes the terminal complete/failed event. */
  readonly maxEventsPerCommand: number
}

export type PersistedEventCallback = (commandId: string) => Promise<void>

const notifyPersisted = async (
  callback: PersistedEventCallback | undefined,
  commandId: string
): Promise<void> => {
  try {
    await callback?.(commandId)
  } catch {
    // Persistence is authoritative. A replacement tunnel replays the durable event.
  }
}

export const SESSION_COMMAND_HANDLER_POLICY: SessionCommandHandlerPolicy = {
  maxRetainedCommands: 256,
  maxEventsPerCommand: 4_096
}

const emptyLedger = (): Ledger => ({
  version: 1,
  commands: {},
  transport: {
    nextOutgoingSequence: 1,
    acknowledgedDesktopSequence: 0,
    highestReceivedDesktopSequence: 0,
    acknowledgedOutgoingSequence: 0
  }
})

const terminalRestartEvent = (
  command: RemoteSessionCommand,
  eventSequence: number
): RemoteSessionEvent => ({
  version: 1,
  commandId: command.commandId,
  sessionId: command.sessionId,
  eventSequence,
  kind: "failed",
  payload: {
    code: "device-restarted",
    message: "The device agent restarted before this command settled. The command was not re-executed."
  }
})

const commandLastOutgoingSequence = (command: PersistedCommand): number | null =>
  command.outgoingEnvelopes?.at(-1)?.sequence ?? null

const sameControllerScope = (
  left: ControllerExecutionScope | undefined,
  right: ControllerExecutionScope | undefined
): boolean =>
  left?.clientInstanceId === right?.clientInstanceId &&
  left?.attachmentGeneration === right?.attachmentGeneration &&
  left?.controllerLeaseGeneration === right?.controllerLeaseGeneration

/** Device-side exactly-once boundary. Admission and response ciphertext precede acknowledgement. */
export class SessionCommandHandler {
  readonly #file: string
  readonly #executor: SessionCommandExecutor
  readonly #policy: SessionCommandHandlerPolicy
  #serial: Promise<unknown> = Promise.resolve()
  #initialized: Promise<void> | null = null
  readonly #inFlight = new Map<string, {
    readonly command: RemoteSessionCommand
    readonly receivedSequence?: number
    readonly controllerScope?: ControllerExecutionScope
    readonly result: Promise<ReadonlyArray<RemoteSessionEvent>>
  }>()

  constructor(
    file: string,
    executor: SessionCommandExecutor,
    policy: Partial<SessionCommandHandlerPolicy> = {}
  ) {
    this.#file = file
    this.#executor = executor
    this.#policy = { ...SESSION_COMMAND_HANDLER_POLICY, ...policy }
    if (this.#policy.maxRetainedCommands < 1 || this.#policy.maxEventsPerCommand < 1) {
      throw new Error("Session command retention limits must be positive.")
    }
  }

  async #read(): Promise<Ledger> {
    try {
      const value: unknown = JSON.parse(await readFile(this.#file, "utf8"))
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const record = Object.fromEntries(Object.entries(value))
        if (record.version === 1 && record.commands && record.transport) {
          const ledger = value as Ledger
          const received = Object.values(ledger.commands).reduce(
            (highest, command) => Math.max(highest, command.receivedSequence ?? 0),
            ledger.transport.acknowledgedDesktopSequence
          )
          return {
            ...ledger,
            transport: {
              ...ledger.transport,
              highestReceivedDesktopSequence:
                ledger.transport.highestReceivedDesktopSequence ?? received,
              acknowledgedOutgoingSequence:
                ledger.transport.acknowledgedOutgoingSequence ?? 0
            }
          }
        }
        // Migration from the first command-only ledger shape.
        return {
          ...emptyLedger(),
          commands: value as Record<string, PersistedCommand>
        }
      }
    } catch {
      // Missing/corrupt state starts empty. A corrupt envelope still cannot be acknowledged.
    }
    return emptyLedger()
  }

  async #write(ledger: Ledger): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true })
    const temporary = `${this.#file}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(ledger), { mode: 0o600 })
    await rename(temporary, this.#file)
  }

  #withLedger<A>(update: (ledger: Ledger) => Promise<A> | A): Promise<A> {
    const operation = this.#serial.then(async () => {
      const ledger = await this.#read()
      return update(ledger)
    })
    this.#serial = operation.catch(() => undefined)
    return operation
  }

  #initialize(): Promise<void> {
    if (this.#initialized) return this.#initialized
    this.#initialized = this.#withLedger(async (ledger) => {
      let changed = false
      for (const [commandId, command] of Object.entries(ledger.commands)) {
        if (command.status !== "admitted") continue
        ledger.commands[commandId] = {
          ...command,
          status: "failed",
          events: [
            ...command.events,
            terminalRestartEvent(
              command.command,
              (command.outgoingEnvelopes?.length ?? 0) + command.events.length + 1
            )
          ]
        }
        changed = true
      }
      if (changed) await this.#write(ledger)
    })
    return this.#initialized
  }

  async #advanceIncomingAcknowledgement(ledger: Ledger): Promise<void> {
    let cursor = ledger.transport.acknowledgedDesktopSequence
    while (true) {
      const next = Object.values(ledger.commands).find(
        (command) => command.receivedSequence === cursor + 1
      )
      if (next?.status === "admitted" || !next?.outgoingEnvelopes) break
      cursor += 1
    }
    ledger.transport = { ...ledger.transport, acknowledgedDesktopSequence: cursor }
  }

  /**
   * Advances the device's execution fence before a replacement tunnel can
   * dispatch. The fence is durable so a daemon restart cannot revive an older
   * controller generation.
   */
  adoptControllerScope(scope: ControllerExecutionScope): Promise<void> {
    return this.#initialize().then(() => this.#withLedger(async (ledger) => {
      const current = ledger.controllerScope
      if (current) {
        if (scope.controllerLeaseGeneration < current.controllerLeaseGeneration) {
          throw new Error("Stale controller lease generation.")
        }
        if (
          scope.controllerLeaseGeneration === current.controllerLeaseGeneration &&
          scope.clientInstanceId !== current.clientInstanceId
        ) {
          throw new Error("Controller identity changed without a new lease generation.")
        }
        if (
          scope.controllerLeaseGeneration === current.controllerLeaseGeneration &&
          scope.attachmentGeneration < current.attachmentGeneration
        ) {
          throw new Error("Stale client attachment generation.")
        }
      }
      if (sameControllerScope(current, scope)) return
      if (!current) {
        for (const [commandId, command] of Object.entries(ledger.commands)) {
          if (!command.controllerScope) {
            ledger.commands[commandId] = { ...command, controllerScope: scope }
          }
        }
      }
      ledger.controllerScope = scope
      await this.#write(ledger)
    }))
  }

  transportState(): Promise<Ledger["transport"]> {
    return this.#initialize().then(() => this.#withLedger((ledger) => ledger.transport))
  }

  async #appendEvent(
    command: RemoteSessionCommand,
    event: Omit<RemoteSessionEvent, "version" | "commandId" | "sessionId" | "eventSequence">,
    terminal: boolean
  ): Promise<RemoteSessionEvent> {
    return this.#withLedger(async (ledger) => {
      const persisted = ledger.commands[command.commandId]
      if (persisted?.status !== "admitted") {
        throw new Error(`Command ${command.commandId} lost its active admission.`)
      }
      const eventCount = (persisted.outgoingEnvelopes?.length ?? 0) + persisted.events.length
      const maximum = terminal
        ? this.#policy.maxEventsPerCommand
        : this.#policy.maxEventsPerCommand - 1
      if (eventCount >= maximum) {
        throw new Error(`Remote command exceeded ${this.#policy.maxEventsPerCommand} retained events.`)
      }
      const value: RemoteSessionEvent = {
        version: 1,
        commandId: command.commandId,
        sessionId: command.sessionId,
        eventSequence: eventCount + 1,
        ...event
      }
      ledger.commands[command.commandId] = {
        ...persisted,
        events: [...persisted.events, value]
      }
      await this.#write(ledger)
      return value
    })
  }

  async #settle(commandId: string, status: "complete" | "failed"): Promise<void> {
    await this.#withLedger(async (ledger) => {
      const persisted = ledger.commands[commandId]
      if (persisted?.status !== "admitted") {
        throw new Error(`Command ${commandId} lost its persisted admission.`)
      }
      ledger.commands[commandId] = { ...persisted, status }
      await this.#write(ledger)
    })
  }

  handle(
    command: RemoteSessionCommand,
    receivedSequence?: number,
    onEventPersisted?: PersistedEventCallback,
    controllerScope?: ControllerExecutionScope
  ): Promise<ReadonlyArray<RemoteSessionEvent>> {
    const active = this.#inFlight.get(command.commandId)
    if (active) {
      const sequence = receivedSequence ?? active.receivedSequence
      if (
        JSON.stringify(active.command) !== JSON.stringify(command) ||
        (active.receivedSequence !== undefined && sequence !== active.receivedSequence) ||
        !sameControllerScope(active.controllerScope, controllerScope)
      ) {
        return Promise.reject(new Error(`Command ${command.commandId} conflicts with its active admission.`))
      }
      return active.result
    }

    const result = this.#initialize().then(async () => {
      const admission = await this.#withLedger(async (ledger) => {
        if (controllerScope && !sameControllerScope(ledger.controllerScope, controllerScope)) {
          throw new Error("Stale controller execution scope.")
        }
        const sequence = receivedSequence ?? ledger.transport.highestReceivedDesktopSequence + 1
        const previous = ledger.commands[command.commandId]
        if (previous && (
          JSON.stringify(previous.command) !== JSON.stringify(command) ||
          (previous.receivedSequence !== undefined && previous.receivedSequence !== sequence) ||
          !sameControllerScope(previous.controllerScope, controllerScope)
        )) {
          throw new Error(`Command ${command.commandId} conflicts with its persisted admission.`)
        }
        if (previous?.status === "complete" || previous?.status === "failed") {
          return { previous, sequence } as const
        }
        if (previous?.status === "admitted") {
          throw new Error(`Command ${command.commandId} has an active admission without an executor.`)
        }
        if (sequence <= ledger.transport.highestReceivedDesktopSequence) {
          throw new Error(`Unknown replayed command ${command.commandId} at sequence ${sequence}.`)
        }
        if (sequence !== ledger.transport.highestReceivedDesktopSequence + 1) {
          throw new Error(`Desktop command sequence gap: expected ${ledger.transport.highestReceivedDesktopSequence + 1}, received ${sequence}.`)
        }
        if (Object.keys(ledger.commands).length >= this.#policy.maxRetainedCommands) {
          throw new Error("Remote command retention is full while responses remain unacknowledged.")
        }
        ledger.commands[command.commandId] = {
          command,
          receivedSequence: sequence,
          controllerScope,
          status: "admitted",
          events: []
        }
        ledger.transport = { ...ledger.transport, highestReceivedDesktopSequence: sequence }
        await this.#write(ledger)
        return { previous: null, sequence } as const
      })

      if (admission.previous) return admission.previous.events

      const events: RemoteSessionEvent[] = []
      const emit = async (
        event: Omit<RemoteSessionEvent, "version" | "commandId" | "sessionId" | "eventSequence">
      ) => {
        events.push(await this.#appendEvent(command, event, false))
        await notifyPersisted(onEventPersisted, command.commandId)
      }
      let status: "complete" | "failed"
      let terminal: RemoteSessionEvent
      try {
        const value = await this.#executor.execute(command, emit)
        terminal = await this.#appendEvent(command, {
          kind: "complete",
          payload: value
        }, true)
        status = "complete"
      } catch (error) {
        terminal = await this.#appendEvent(command, {
          kind: "failed",
          payload: { message: error instanceof Error ? error.message : "Remote command failed." }
        }, true)
        status = "failed"
      }
      events.push(terminal)
      await this.#settle(command.commandId, status)
      await notifyPersisted(onEventPersisted, command.commandId)
      return events
    })

    this.#inFlight.set(command.commandId, {
      command,
      receivedSequence,
      controllerScope,
      result
    })
    result.finally(() => {
      if (this.#inFlight.get(command.commandId)?.result === result) {
        this.#inFlight.delete(command.commandId)
      }
    }).catch(() => undefined)
    return result
  }

  /** Allocates and persists ciphertext sequences before the relay can observe or acknowledge them. */
  prepareOutgoingEnvelopes(
    commandId: string,
    encrypt: (event: RemoteSessionEvent, sequence: number) => EncryptedTunnelEnvelope
  ): Promise<ReadonlyArray<EncryptedTunnelEnvelope>> {
    return this.#initialize().then(() => this.#withLedger(async (ledger) => {
      const command = ledger.commands[commandId]
      if (!command) throw new Error(`Unknown command ${commandId}.`)
      let next = ledger.transport.nextOutgoingSequence
      const appended = command.events.map((event) => encrypt(event, next++))
      const outgoingEnvelopes = [...(command.outgoingEnvelopes ?? []), ...appended]
      if (appended.length === 0) return outgoingEnvelopes
      ledger.commands[commandId] = {
        ...command,
        // Ciphertext is now the replay source of truth. Do not retain the full
        // transcript a second time in plaintext.
        events: [],
        outgoingEnvelopes
      }
      ledger.transport = { ...ledger.transport, nextOutgoingSequence: next }
      await this.#advanceIncomingAcknowledgement(ledger)
      await this.#write(ledger)
      return outgoingEnvelopes
    }))
  }

  /** Returns durable ciphertext for reconnect replay without re-encrypting plaintext events. */
  pendingOutgoingEnvelopes(afterSequence: number): Promise<ReadonlyArray<EncryptedTunnelEnvelope>> {
    return this.#initialize().then(() => this.#withLedger((ledger) =>
      Object.values(ledger.commands)
        .flatMap((command) => command.outgoingEnvelopes ?? [])
        .filter((envelope) => envelope.sequence > afterSequence)
        .sort((left, right) => left.sequence - right.sequence)
    ))
  }

  /** Prunes only responses the relay confirms the desktop has consumed. */
  acknowledgeOutgoing(acknowledgedSequence: number): Promise<void> {
    return this.#initialize().then(() => this.#withLedger(async (ledger) => {
      const maximum = ledger.transport.nextOutgoingSequence - 1
      if (!Number.isSafeInteger(acknowledgedSequence) || acknowledgedSequence < 0 || acknowledgedSequence > maximum) {
        throw new Error(`Invalid desktop acknowledgement ${acknowledgedSequence}; maximum persisted sequence is ${maximum}.`)
      }
      if (acknowledgedSequence <= ledger.transport.acknowledgedOutgoingSequence) return
      ledger.transport = { ...ledger.transport, acknowledgedOutgoingSequence: acknowledgedSequence }
      for (const [commandId, command] of Object.entries(ledger.commands)) {
        const lastSequence = commandLastOutgoingSequence(command)
        if (
          command.status !== "admitted" &&
          (command.receivedSequence ?? Number.POSITIVE_INFINITY) <=
            ledger.transport.acknowledgedDesktopSequence &&
          lastSequence !== null &&
          lastSequence <= acknowledgedSequence
        ) {
          delete ledger.commands[commandId]
        }
      }
      await this.#write(ledger)
    }))
  }
}
