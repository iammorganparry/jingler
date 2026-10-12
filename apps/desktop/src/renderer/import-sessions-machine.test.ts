import type { ImportableSession } from "@jingler/core"
import { importSessionKey } from "@jingler/ui"
import { createActor, fromPromise, waitFor } from "xstate"
import { describe, expect, it, vi } from "vitest"
import { importSessionsMachine } from "./import-sessions-machine.js"

const make = (nativeSessionId: string, alreadyImported = false): ImportableSession => ({
  source: "claude-code",
  nativeSessionId,
  harness: "claude",
  cwd: "/dev/jingler",
  title: `Session ${nativeSessionId}`,
  updatedAt: "2026-10-01T10:00:00.000Z",
  messageCount: 2,
  folderExists: true,
  alreadyImported
})
const [a, b, c] = [make("a"), make("b"), make("c", true)]

const start = (scan: () => Promise<ReadonlyArray<ImportableSession>>, importOne = vi.fn(async (_session: ImportableSession) => ({}))) => {
  const actor = createActor(
    importSessionsMachine.provide({
      actors: { scan: fromPromise(scan), importOne: fromPromise(async ({ input }) => importOne(input)) }
    })
  ).start()
  return { actor, importOne }
}

describe("importSessionsMachine", () => {
  it("scans into ready with candidates", async () => {
    const { actor } = start(async () => [a, b])
    const snapshot = await waitFor(actor, (s) => s.matches("ready"))
    expect(snapshot.context.candidates).toEqual([a, b])
  })

  it("fails the scan, then RETRY rescans", async () => {
    const scan = vi.fn<() => Promise<ReadonlyArray<ImportableSession>>>().mockRejectedValueOnce(new Error("boom"))
    scan.mockResolvedValueOnce([a])
    const { actor } = start(scan)
    expect((await waitFor(actor, (s) => s.matches("failed"))).context.error).toBe("boom")
    actor.send({ type: "RETRY" })
    expect((await waitFor(actor, (s) => s.matches("ready"))).context.candidates).toEqual([a])
  })

  it("imports each selected session, ignoring already-imported rows", async () => {
    const { actor, importOne } = start(async () => [a, b, c])
    await waitFor(actor, (s) => s.matches("ready"))
    for (const session of [a, b, c]) actor.send({ type: "TOGGLE", key: importSessionKey(session) })
    expect(actor.getSnapshot().context.selected.size).toBe(2)
    actor.send({ type: "IMPORT" })
    await waitFor(actor, (s) => s.status === "done")
    expect(importOne.mock.calls.map(([session]) => session.nativeSessionId)).toEqual(["a", "b"])
  })

  it("SKIP finishes without importing", async () => {
    const { actor, importOne } = start(async () => [a])
    await waitFor(actor, (s) => s.matches("ready"))
    actor.send({ type: "SKIP" })
    expect(actor.getSnapshot().status).toBe("done")
    expect(importOne).not.toHaveBeenCalled()
  })
})
