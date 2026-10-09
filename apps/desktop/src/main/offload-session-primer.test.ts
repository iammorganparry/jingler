import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { primeOffloadSessions } from "./offload-session-primer.js"

describe("Offload session priming", () => {
  it("contains stale-session failures and bounds concurrent requests", async () => {
    let active = 0
    let maximum = 0
    const attempted: string[] = []
    const sessions = Array.from({ length: 8 }, (_, index) => ({
      id: `session-${index}`,
      worktreePath: `/repo/${index}`
    }))
    await Effect.runPromise(primeOffloadSessions(
      sessions,
      (_cwd, sessionId) => Effect.tryPromise({
        try: async () => {
          attempted.push(sessionId)
          active += 1
          maximum = Math.max(maximum, active)
          await new Promise((resolve) => setTimeout(resolve, 2))
          active -= 1
          if (sessionId === "session-3") throw new Error("stale worktree")
        },
        catch: (cause) => cause
      })
    ))
    expect(attempted).toHaveLength(8)
    expect(maximum).toBeLessThanOrEqual(3)
  })
  it("never primes safe or archived workspaces when enabling offload", async () => {
    const attempted: string[] = []
    await Effect.runPromise(primeOffloadSessions([{ id: "safe", worktreePath: "/safe", checkpointSafeMode: true }, { id: "archived", worktreePath: "/archived", archived: true }, { id: "normal", worktreePath: "/normal" }], (_cwd, id) => Effect.sync(() => attempted.push(id))))
    expect(attempted).toEqual(["normal"])
  })
})
