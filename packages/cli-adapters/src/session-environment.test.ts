import { Effect, Exit } from "effect"
import { describe, expect, it, vi } from "vitest"
import type { Environment, Session } from "@jingler/core"
import { continueSessionOnEnvironment, setSessionEnvironment } from "./session-environment.js"

const source = (patch: Partial<Session> = {}): Session => ({
  id: "s_source", repo: "acme/app", branch: "main", title: "Source", status: "idle", cli: "claude",
  diff: { added: 0, removed: 0 }, prNumber: null, costUsd: 0, tokens: 0,
  updatedAt: "2026-08-08T00:00:00.000Z", chats: [{ id: "c_source", title: null, createdAt: "2026-08-08T00:00:00.000Z", updatedAt: "2026-08-08T00:00:00.000Z" }], activeChatId: "c_source", ...patch
})
const target: Environment = { id: "clive", name: "clive.local", platform: { os: "darwin", arch: "arm64" }, capabilities: { version: 1, capabilities: ["session.start"], harnesses: ["claude"], maxConcurrentSessions: 4 }, state: "online", agentVersion: "2.0.3", lastSeenAt: 1 }

describe("session environment handoff", () => {
  const deps = () => {
    const persist = vi.fn((id: string, environmentId?: string) => Effect.succeed({ ...source(), id, environmentId }))
    const continueSession = vi.fn((session: Session, environmentId?: string) => Effect.succeed({ ...session, id: "s_continuation", environmentId }))
    return { persist, continueSession, environments: () => Effect.succeed([target]) }
  }
  it("re-provisions a pristine session in place", async () => {
    const d = deps(); const result = await Effect.runPromise(setSessionEnvironment(source(), "clive", d)); expect(result.id).toBe("s_source"); expect(d.persist).toHaveBeenCalledOnce()
  })
  it("creates a continuation when the source session contains work", async () => {
    const d = deps(); const result = await Effect.runPromise(continueSessionOnEnvironment(source({ diff: { added: 2, removed: 0 } }), "clive", d)); expect(result.id).toBe("s_continuation"); expect(d.persist).not.toHaveBeenCalled()
  })
  it("preserves the source session when handoff fails", async () => {
    const base = deps(); const d = { ...base, continueSession: vi.fn(() => Effect.fail(new Error("provision failed"))) }; const exit = await Effect.runPromiseExit(continueSessionOnEnvironment(source({ tokens: 1 }), "clive", d)); expect(Exit.isFailure(exit)).toBe(true); expect(base.persist).not.toHaveBeenCalled()
  })
  it("rejects a target missing the required repository or harness", async () => {
    const d = deps(); d.environments = () => Effect.succeed([{ ...target, capabilities: { ...target.capabilities, harnesses: ["codex" as const] } }]); const exit = await Effect.runPromiseExit(continueSessionOnEnvironment(source(), "clive", d)); expect(Exit.isFailure(exit)).toBe(true); expect(d.continueSession).not.toHaveBeenCalled()
  })
})
