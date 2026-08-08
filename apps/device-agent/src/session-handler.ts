import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { EncryptedTunnelEnvelope, RemoteSessionCommand, RemoteSessionEvent } from "@jingler/core"

interface PersistedCommand {
  readonly command: RemoteSessionCommand
  readonly receivedSequence?: number
  readonly status: "admitted" | "complete" | "failed"
  readonly events: ReadonlyArray<RemoteSessionEvent>
  readonly outgoingEnvelopes?: ReadonlyArray<EncryptedTunnelEnvelope>
}

interface Ledger {
  readonly version: 1
  readonly commands: Record<string, PersistedCommand>
  transport: {
    readonly nextOutgoingSequence: number
    readonly acknowledgedDesktopSequence: number
  }
}

export interface SessionCommandExecutor {
  readonly execute: (
    command: RemoteSessionCommand,
    emit: (event: Omit<RemoteSessionEvent, "version" | "commandId" | "sessionId" | "eventSequence">) => Promise<void>
  ) => Promise<unknown>
}

/** Device-side exactly-once boundary. Admission and completion precede acknowledgement. */
export class SessionCommandHandler {
  readonly #file: string
  readonly #executor: SessionCommandExecutor
  #serial: Promise<unknown> = Promise.resolve()

  constructor(file: string, executor: SessionCommandExecutor) {
    this.#file = file
    this.#executor = executor
  }

  async #read(): Promise<Ledger> {
    try {
      const value: unknown = JSON.parse(await readFile(this.#file, "utf8"))
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const record = Object.fromEntries(Object.entries(value))
        if (record.version === 1 && record.commands && record.transport) return value as Ledger
        // Migration from the first command-only ledger shape.
        return {
          version: 1,
          commands: value as Record<string, PersistedCommand>,
          transport: { nextOutgoingSequence: 1, acknowledgedDesktopSequence: 0 }
        }
      }
    } catch {
      // Missing/corrupt state starts empty. A corrupt envelope still cannot be acknowledged.
    }
    return {
      version: 1,
      commands: {},
      transport: { nextOutgoingSequence: 1, acknowledgedDesktopSequence: 0 }
    }
  }

  async #write(ledger: Ledger): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true })
    const temporary = `${this.#file}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(ledger), { mode: 0o600 })
    await rename(temporary, this.#file)
  }

  transportState(): Promise<Ledger["transport"]> {
    return this.#serial.then(() => this.#read().then((ledger) => ledger.transport))
  }

  handle(command: RemoteSessionCommand, receivedSequence?: number): Promise<ReadonlyArray<RemoteSessionEvent>> {
    const operation = this.#serial.then(async () => {
      const ledger = await this.#read()
      const sequence = receivedSequence ?? ledger.transport.acknowledgedDesktopSequence + 1
      if (sequence > ledger.transport.acknowledgedDesktopSequence + 1) {
        throw new Error(`Desktop command sequence gap: expected ${ledger.transport.acknowledgedDesktopSequence + 1}, received ${sequence}.`)
      }
      const previous = ledger.commands[command.commandId]
      if (previous && (
        JSON.stringify(previous.command) !== JSON.stringify(command) ||
        (previous.receivedSequence !== undefined && previous.receivedSequence !== sequence)
      )) {
        throw new Error(`Command ${command.commandId} conflicts with its persisted admission.`)
      }
      if (previous?.status === "complete" || previous?.status === "failed") return previous.events
      if (previous?.status === "admitted") throw new Error(`Command ${command.commandId} was admitted but did not settle.`)
      if (sequence <= ledger.transport.acknowledgedDesktopSequence) {
        throw new Error(`Unknown replayed command ${command.commandId} at sequence ${sequence}.`)
      }
      ledger.commands[command.commandId] = { command, receivedSequence: sequence, status: "admitted", events: [] }
      await this.#write(ledger)
      const events: RemoteSessionEvent[] = []
      const emit = async (event: Omit<RemoteSessionEvent, "version" | "commandId" | "sessionId" | "eventSequence">) => {
        events.push({ version: 1, commandId: command.commandId, sessionId: command.sessionId, eventSequence: events.length + 1, ...event })
      }
      try {
        const result = await this.#executor.execute(command, emit)
        await emit({ kind: "complete", payload: result })
        ledger.commands[command.commandId] = { command, receivedSequence: sequence, status: "complete", events }
      } catch (error) {
        await emit({ kind: "failed", payload: { message: error instanceof Error ? error.message : "Remote command failed." } })
        ledger.commands[command.commandId] = { command, receivedSequence: sequence, status: "failed", events }
      }
      ledger.transport = { ...ledger.transport, acknowledgedDesktopSequence: sequence }
      await this.#write(ledger)
      return events
    })
    this.#serial = operation.catch(() => undefined)
    return operation
  }

  /** Allocates and persists ciphertext sequences before the relay can observe them. */
  prepareOutgoingEnvelopes(
    commandId: string,
    encrypt: (event: RemoteSessionEvent, sequence: number) => EncryptedTunnelEnvelope
  ): Promise<ReadonlyArray<EncryptedTunnelEnvelope>> {
    const operation = this.#serial.then(async () => {
      const ledger = await this.#read()
      const command = ledger.commands[commandId]
      if (!command) throw new Error(`Unknown command ${commandId}.`)
      if (command.outgoingEnvelopes) return command.outgoingEnvelopes
      let next = ledger.transport.nextOutgoingSequence
      const outgoingEnvelopes = command.events.map((event) => encrypt(event, next++))
      ledger.commands[commandId] = { ...command, outgoingEnvelopes }
      ledger.transport = { ...ledger.transport, nextOutgoingSequence: next }
      await this.#write(ledger)
      return outgoingEnvelopes
    })
    this.#serial = operation.catch(() => undefined)
    return operation
  }
}
