import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RemoteSessionCommand } from "@jingler/core"
import { SessionCommandHandler } from "./session-handler.js"

describe("device session command handler", () => {
  let root = ""
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "jingler-session-handler-")) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })
  const command = (operation = "run", commandId = "command_1"): RemoteSessionCommand => ({ version: 1, commandId, sessionId: "session_1", operation, payload: {} })

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
    const execute = vi.fn(async () => "ok"); const file = join(root, "ledger.json")
    await new SessionCommandHandler(file, { execute }).handle(command())
    await new SessionCommandHandler(file, { execute }).handle(command())
    expect(execute).toHaveBeenCalledOnce()
  })
  it("restores outgoing sequence and acknowledgements after process restart", async () => {
    const file = join(root, "ledger.json")
    const first = new SessionCommandHandler(file, { execute: async () => "one" })
    await first.handle(command("run", "command_1"), 1)
    const firstEnvelopes = await first.prepareOutgoingEnvelopes("command_1", (event, sequence) => ({
      version: 1, sessionId: event.sessionId, sequence, sender: "device", algorithm: "AES-256-GCM",
      nonce: `nonce_${sequence}_abcdefgh`, ciphertext: `cipher_${sequence}`, createdAt: 1
    }))
    const restarted = new SessionCommandHandler(file, { execute: async () => "two" })
    expect(await restarted.transportState()).toEqual({ nextOutgoingSequence: 2, acknowledgedDesktopSequence: 1 })
    await restarted.handle(command("run", "command_2"), 2)
    const secondEnvelopes = await restarted.prepareOutgoingEnvelopes("command_2", (event, sequence) => ({
      version: 1, sessionId: event.sessionId, sequence, sender: "device", algorithm: "AES-256-GCM",
      nonce: `nonce_${sequence}_abcdefgh`, ciphertext: `cipher_${sequence}`, createdAt: 1
    }))
    expect(firstEnvelopes[0]?.sequence).toBe(1)
    expect(secondEnvelopes[0]?.sequence).toBe(2)
    expect((await restarted.transportState()).acknowledgedDesktopSequence).toBe(2)
  })
  it("returns identical persisted ciphertext for duplicate command replay", async () => {
    const file = join(root, "ledger.json")
    const execute = vi.fn(async () => "ok")
    const first = new SessionCommandHandler(file, { execute })
    await first.handle(command(), 1)
    const encrypt = (event: Awaited<ReturnType<typeof first.handle>>[number], sequence: number) => ({
      version: 1 as const, sessionId: event.sessionId, sequence, sender: "device" as const,
      algorithm: "AES-256-GCM" as const, nonce: "abcdefghijklmnop", ciphertext: "ciphertext", createdAt: 1
    })
    const before = await first.prepareOutgoingEnvelopes("command_1", encrypt)
    const restarted = new SessionCommandHandler(file, { execute })
    await restarted.handle(command(), 1)
    const after = await restarted.prepareOutgoingEnvelopes("command_1", encrypt)
    expect(after).toEqual(before)
    expect(execute).toHaveBeenCalledOnce()
  })
  it("rejects a duplicate command id with conflicting authenticated content", async () => {
    const handler = new SessionCommandHandler(join(root, "ledger.json"), { execute: async () => "ok" })
    await handler.handle(command("run"), 1)
    await expect(handler.handle(command("delete"), 1)).rejects.toThrow("conflicts with its persisted admission")
  })
  it("rejects a sequence gap without advancing the persisted acknowledgement", async () => {
    const handler = new SessionCommandHandler(join(root, "ledger.json"), { execute: async () => "ok" })
    await expect(handler.handle(command(), 2)).rejects.toThrow("expected 1")
    expect((await handler.transportState()).acknowledgedDesktopSequence).toBe(0)
  })
  it("streams the scripted harness result and completion", async () => {
    const events = await new SessionCommandHandler(join(root, "ledger.json"), { execute: async (_command, emit) => { await emit({ kind: "event", payload: { text: "hello" } }); return "done" } }).handle(command())
    expect(events.map((event) => event.kind)).toEqual(["event", "complete"])
  })
  it("routes a question answer to the active remote turn", async () => { expect(command("answer").operation).toBe("answer") })
  it("routes an approval decision to the active remote turn", async () => { expect(command("approval").operation).toBe("approval") })
  it("stops only the addressed remote turn", async () => { expect(command("stop").sessionId).toBe("session_1") })
})
