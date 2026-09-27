import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { UsageFactStore } from "./usage-facts.js"
import type { UsageFact } from "@jingler/core"

const makeFact = (over: Partial<UsageFact> = {}): UsageFact => ({
  id: "run-1",
  runId: "run-1",
  sessionId: "session-1",
  chatId: "chat-1",
  parentRunId: null,
  runtimeId: "pi",
  providerId: "anthropic",
  modelId: "claude-sonnet",
  kind: "parent",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:00:01.000Z",
  durationMs: 1000,
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
  totalTokens: null,
  costUsd: null,
  toolCalls: 0,
  outcome: "unknown",
  provenance: "test",
  ...over
})

describe("UsageFactStore", () => {
  it("upserts terminal facts and exports the same report data", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-usage-"))
    const store = new UsageFactStore(join(root, "usage.json"))
    await store.record(makeFact())
    await store.record(makeFact({ outcome: "success", durationMs: 2000 }))
    expect((await store.list())).toHaveLength(1)
    expect((await store.report()).groups[0]?.successRate).toBe(1)
    expect(JSON.parse(await store.exportJson()).facts[0].durationMs).toBe(2000)
    await Promise.all([
      store.record(makeFact({ id: "run-2", runId: "run-2" })),
      new UsageFactStore(join(root, "usage.json")).record(
        makeFact({ id: "run-3", runId: "run-3" })
      )
    ])
    expect((await store.list())).toHaveLength(3)
    expect((await readFile(join(root, "usage.json"), "utf8"))).toContain("run-1")
  })

  it("does not erase a malformed usage ledger", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-usage-malformed-"))
    const file = join(root, "usage.json")
    await writeFile(file, "not-json")
    const store = new UsageFactStore(file)
    await expect(store.record(makeFact())).rejects.toThrow()
    expect(await readFile(file, "utf8")).toBe("not-json")
  })
})
