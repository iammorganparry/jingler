import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { RunJournal } from "./run-journal.js"

const roots: Array<string> = []
const identity = { sessionId: "session-1", chatId: "chat-1" } as const
const journal = async (): Promise<{ readonly file: string; readonly value: RunJournal }> => {
  const root = await mkdtemp(join(tmpdir(), "jingler-journal-"))
  roots.push(root)
  const file = join(root, "runtime", "run-journal.json")
  return { file, value: new RunJournal({ file, now: () => new Date("2026-08-10T12:00:00.000Z") }) }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("RunJournal", () => {
  it("does not retry an orphaned mutation after restart", async () => {
    const { file, value } = await journal()
    await Effect.runPromise(value.start({ ...identity, callId: "call-1", runId: "run-1", toolId: "workspace.edit", risk: "mutate", targetCategory: "workspace-file" }))
    const restarted = new RunJournal({ file })
    expect(await Effect.runPromise(restarted.reconcileAfterRestart())).toMatchObject([
      { callId: "call-1", status: "uncertain", safeToRetry: false }
    ])
  })

  it("marks an interrupted read as retryable but never replays it", async () => {
    const { file, value } = await journal()
    await Effect.runPromise(value.start({ ...identity, callId: "call-read", runId: "run-1", toolId: "workspace.read", risk: "read" }))
    const restarted = new RunJournal({ file })
    expect(await Effect.runPromise(restarted.reconcileAfterRestart())).toEqual([])
    expect(await Effect.runPromise(restarted.list())).toMatchObject([{ status: "failed", safeToRetry: true }])
  })

  it("persists settled diff references without raw arguments or source patches", async () => {
    const { file, value } = await journal()
    await Effect.runPromise(value.start({ ...identity, callId: "call-1", runId: "run-1", toolId: "workspace.edit", risk: "mutate" }))
    await Effect.runPromise(value.settle({ callId: "call-1", status: "settled", resultSummary: "updated workspace file", fileChangeSetIds: ["changes-1"] }))
    const raw = await readFile(file, "utf8")
    expect(raw).toContain("changes-1")
    expect(raw).not.toContain("diff --git")
    expect(raw).not.toContain("arguments")
  })

  it("serializes concurrent starts without losing receipts", async () => {
    const { value } = await journal()
    await Effect.runPromise(Effect.all([
      value.start({ ...identity, callId: "a", runId: "run", toolId: "one", risk: "read" }),
      value.start({ ...identity, callId: "b", runId: "run", toolId: "two", risk: "network" })
    ], { concurrency: "unbounded" }))
    expect(await Effect.runPromise(value.list())).toHaveLength(2)
  })
})
