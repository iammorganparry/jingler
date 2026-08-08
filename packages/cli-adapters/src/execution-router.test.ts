import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { Session } from "@jingler/core"
import { routeSessionOperation } from "./execution-router.js"

const session = (environmentId?: string): Session => ({
  id: "s_test", repo: "acme/app", branch: "main", title: "Test", status: "idle", cli: "claude",
  ...(environmentId ? { environmentId } : {}), diff: { added: 0, removed: 0 }, prNumber: null,
  costUsd: 0, tokens: 0, updatedAt: "2026-08-08T00:00:00.000Z",
  chats: [{ id: "c_test", title: null, createdAt: "2026-08-08T00:00:00.000Z", updatedAt: "2026-08-08T00:00:00.000Z" }],
  activeChatId: "c_test"
})

describe("ExecutionRouter", () => {
  const local = { execute: () => Effect.succeed("local") }
  const remote = { execute: () => Effect.succeed("remote") }
  it("routes legacy sessions to local execution", async () => {
    await expect(Effect.runPromise(routeSessionOperation(session(), "run", {}, local, remote))).resolves.toBe("local")
  })
  it("routes remote sessions only to their paired environment", async () => {
    await expect(Effect.runPromise(routeSessionOperation(session("clive"), "run", {}, local, remote))).resolves.toBe("remote")
  })
  it("fails an unavailable remote environment without local fallback", async () => {
    let localCalls = 0
    await expect(Effect.runPromise(routeSessionOperation(session("offline"), "run", {}, { execute: () => { localCalls += 1; return Effect.succeed("local") } }, { execute: () => Effect.fail(new Error("offline")) }))).rejects.toThrow("offline")
    expect(localCalls).toBe(0)
  })
})
