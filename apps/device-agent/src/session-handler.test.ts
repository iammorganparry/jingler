import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RemoteSessionCommand, RemoteSessionEvent } from "@jingler/core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SessionCommandHandler, type SessionCommandExecutor } from "./session-handler.js"

describe("device session command handler", () => {
  let root = ""
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "jingler-session-handler-")) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  const command = (operation = "run", commandId = "command_1"): RemoteSessionCommand => ({
    version: 1,
    commandId,
    sessionId: "session_1",
    operation,
    payload: {}
  })
  const encrypt = (event: RemoteSessionEvent, sequence: number) => ({
    version: 1 as const,
    sessionId: event.sessionId,
    sequence,
    sender: "device" as const,
    algorithm: "AES-256-GCM" as const,
    nonce: `nonce_${sequence}_abcdefgh`,
    ciphertext: `cipher_${sequence}`,
    createdAt: 1
  })

  it("persists command admission before starting the harness", async () => {
    const file = join(root, "ledger.json")
    const execute = vi.fn(async () => {
      const persisted = JSON.parse(await readFile(file, "utf8"))
      expect(persisted.commands.command_1.status).toBe("admitted")
      expect(persisted.transport.acknowledgedDesktopSequence).toBe(0)
      return "ok"
    })
    await new SessionCommandHandler(file, { execute }).handle(command(), 1)
    expect(execute).toHaveBeenCalledOnce()
  })

  it("executes a command id only once across reconnect", async () => {
    const execute = vi.fn(async () => "ok")
    const file = join(root, "ledger.json")
    const first = new SessionCommandHandler(file, { execute })
    await first.handle(command(), 1)
    await first.prepareOutgoingEnvelopes("command_1", encrypt)
    const restarted = new SessionCommandHandler(file, { execute })
    await restarted.handle(command(), 1)
    expect(await restarted.prepareOutgoingEnvelopes("command_1", encrypt)).toHaveLength(1)
    expect(execute).toHaveBeenCalledOnce()
  })

  it("settles a command left admitted by a device crash as a deterministic restart failure", async () => {
    const file = join(root, "ledger.json")
    await writeFile(file, JSON.stringify({
      version: 1,
      commands: {
        command_1: {
          command: command(),
          receivedSequence: 1,
          status: "admitted",
          events: [],
          outgoingEnvelopes: [{
            version: 1,
            sessionId: "session_1",
            sequence: 1,
            sender: "device",
            algorithm: "AES-256-GCM",
            nonce: "nonce_1_abcdefgh",
            ciphertext: "cipher_1",
            createdAt: 1
          }]
        }
      },
      transport: {
        nextOutgoingSequence: 2,
        acknowledgedDesktopSequence: 0,
        highestReceivedDesktopSequence: 1,
        acknowledgedOutgoingSequence: 0
      }
    }))
    const execute = vi.fn(async () => "must not run")
    const restarted = new SessionCommandHandler(file, { execute })

    expect((await restarted.transportState()).acknowledgedDesktopSequence).toBe(0)
    const events = await restarted.handle(command(), 1)
    expect(events).toEqual([
      expect.objectContaining({
        kind: "failed",
        eventSequence: 2,
        payload: expect.objectContaining({ code: "device-restarted" })
      })
    ])
    expect(execute).not.toHaveBeenCalled()

    const outgoing = await restarted.prepareOutgoingEnvelopes("command_1", encrypt)
    expect(outgoing).toHaveLength(2)
    expect((await restarted.transportState()).acknowledgedDesktopSequence).toBe(1)
  })

  it("does not acknowledge the crash window before response ciphertext is durable", async () => {
    const file = join(root, "ledger.json")
    const handler = new SessionCommandHandler(file, { execute: async () => "ok" })
    await handler.handle(command(), 1)
    expect((await handler.transportState()).acknowledgedDesktopSequence).toBe(0)
    await handler.prepareOutgoingEnvelopes("command_1", encrypt)
    expect((await handler.transportState()).acknowledgedDesktopSequence).toBe(1)
  })

  it("flushes a live run event while a control command completes concurrently", async () => {
    const file = join(root, "ledger.json")
    let releaseRun: (() => void) | undefined
    const runGate = new Promise<void>((resolve) => { releaseRun = resolve })
    const execute = vi.fn(async (
      input: RemoteSessionCommand,
      emit: Parameters<SessionCommandExecutor["execute"]>[1]
    ) => {
      if (input.operation === "run") {
        await emit({ kind: "event", payload: { text: "running" } })
        await runGate
      }
      return input.operation
    })
    const handler = new SessionCommandHandler(file, { execute })
    const flushed: string[] = []
    const flush = async (commandId: string) => {
      await handler.prepareOutgoingEnvelopes(commandId, encrypt)
      flushed.push(commandId)
    }
    const running = handler.handle(command("run", "command_run"), 1, flush)
    await vi.waitFor(() => expect(flushed).toContain("command_run"))
    expect((await handler.prepareOutgoingEnvelopes("command_run", encrypt))[0]?.sequence).toBe(1)

    const stopped = await handler.handle(command("stop", "command_stop"), 2)
    expect(stopped.at(-1)).toMatchObject({ kind: "complete", payload: "stop" })
    await handler.prepareOutgoingEnvelopes("command_stop", encrypt)
    expect((await handler.transportState()).acknowledgedDesktopSequence).toBe(0)
    await handler.acknowledgeOutgoing(2)
    // The desktop consumed command 2's response, but the relay cannot yet be
    // told to drop command 2 while command 1 remains unsettled.
    expect(await handler.prepareOutgoingEnvelopes("command_stop", encrypt)).toHaveLength(1)
    await handler.handle(command("stop", "command_stop"), 2)

    releaseRun?.()
    await running
    await handler.prepareOutgoingEnvelopes("command_run", encrypt)
    expect((await handler.transportState()).acknowledgedDesktopSequence).toBe(2)
  })

  it("restores outgoing sequence and acknowledgements after process restart", async () => {
    const file = join(root, "ledger.json")
    const first = new SessionCommandHandler(file, { execute: async () => "one" })
    await first.handle(command("run", "command_1"), 1)
    const firstEnvelopes = await first.prepareOutgoingEnvelopes("command_1", encrypt)
    const restarted = new SessionCommandHandler(file, { execute: async () => "two" })
    expect(await restarted.transportState()).toEqual({
      nextOutgoingSequence: 2,
      acknowledgedDesktopSequence: 1,
      highestReceivedDesktopSequence: 1,
      acknowledgedOutgoingSequence: 0
    })
    await restarted.handle(command("run", "command_2"), 2)
    const secondEnvelopes = await restarted.prepareOutgoingEnvelopes("command_2", encrypt)
    expect(firstEnvelopes[0]?.sequence).toBe(1)
    expect(secondEnvelopes[0]?.sequence).toBe(2)
    expect((await restarted.transportState()).acknowledgedDesktopSequence).toBe(2)
  })

  it("returns identical persisted ciphertext for duplicate command replay", async () => {
    const file = join(root, "ledger.json")
    const execute = vi.fn(async () => "ok")
    const first = new SessionCommandHandler(file, { execute })
    await first.handle(command(), 1)
    const before = await first.prepareOutgoingEnvelopes("command_1", encrypt)
    const restarted = new SessionCommandHandler(file, { execute })
    await restarted.handle(command(), 1)
    const after = await restarted.prepareOutgoingEnvelopes("command_1", encrypt)
    expect(after).toEqual(before)
    expect(execute).toHaveBeenCalledOnce()
  })

  it("prunes acknowledged ciphertext and its duplicate plaintext history", async () => {
    const file = join(root, "ledger.json")
    const handler = new SessionCommandHandler(file, {
      execute: async (_input, emit) => {
        await emit({ kind: "event", payload: { text: "hello" } })
        return "done"
      }
    })
    await handler.handle(command(), 1)
    await handler.prepareOutgoingEnvelopes("command_1", encrypt)
    const compacted = JSON.parse(await readFile(file, "utf8"))
    expect(compacted.commands.command_1.events).toEqual([])
    expect(compacted.commands.command_1.outgoingEnvelopes).toHaveLength(2)

    await handler.acknowledgeOutgoing(2)
    const pruned = JSON.parse(await readFile(file, "utf8"))
    expect(pruned.commands).toEqual({})
    expect(pruned.transport.acknowledgedOutgoingSequence).toBe(2)
  })

  it("caps unacknowledged command retention without sacrificing replay", async () => {
    const file = join(root, "ledger.json")
    const handler = new SessionCommandHandler(
      file,
      { execute: async (input) => input.commandId },
      { maxRetainedCommands: 2 }
    )
    await handler.handle(command("run", "command_1"), 1)
    await handler.prepareOutgoingEnvelopes("command_1", encrypt)
    await handler.handle(command("run", "command_2"), 2)
    await handler.prepareOutgoingEnvelopes("command_2", encrypt)
    await expect(handler.handle(command("run", "command_3"), 3)).rejects.toThrow("retention is full")

    expect(await handler.prepareOutgoingEnvelopes("command_1", encrypt)).toHaveLength(1)
    await handler.acknowledgeOutgoing(1)
    await handler.handle(command("run", "command_3"), 3)
    expect(await handler.prepareOutgoingEnvelopes("command_3", encrypt)).toHaveLength(1)
  })

  it("caps per-command event history with a terminal failure", async () => {
    const handler = new SessionCommandHandler(
      join(root, "ledger.json"),
      {
        execute: async (_input, emit) => {
          await emit({ kind: "event", payload: 1 })
          await emit({ kind: "event", payload: 2 })
          return "unreachable"
        }
      },
      { maxEventsPerCommand: 2 }
    )
    const events = await handler.handle(command(), 1)
    expect(events).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({
      kind: "failed",
      payload: { message: "Remote command exceeded 2 retained events." }
    })
  })

  it("rejects a duplicate command id with conflicting authenticated content", async () => {
    const handler = new SessionCommandHandler(join(root, "ledger.json"), { execute: async () => "ok" })
    await handler.handle(command("run"), 1)
    await expect(handler.handle(command("delete"), 1)).rejects.toThrow("conflicts with its persisted admission")
  })

  it("rejects a sequence gap without advancing persisted cursors", async () => {
    const handler = new SessionCommandHandler(join(root, "ledger.json"), { execute: async () => "ok" })
    await expect(handler.handle(command(), 2)).rejects.toThrow("expected 1")
    expect((await handler.transportState()).highestReceivedDesktopSequence).toBe(0)
  })

  it("streams the scripted harness result and completion", async () => {
    const events = await new SessionCommandHandler(join(root, "ledger.json"), {
      execute: async (_input, emit) => {
        await emit({ kind: "event", payload: { text: "hello" } })
        return "done"
      }
    }).handle(command())
    expect(events.map((event) => event.kind)).toEqual(["event", "complete"])
  })
})
