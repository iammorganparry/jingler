import { Effect, Exit, Schema } from "effect"
import { describe, expect, it, vi } from "vitest"
import type { Environment, Session } from "@jingler/core"
import {
  CURRENT_RUNTIME_CONTRACTS,
  ProviderConnectionId,
  ProviderId,
  ProviderModelId
} from "@jingler/core"
import {
  continueSessionOnEnvironment,
  environmentRuntimeIsCurrent,
  setSessionEnvironment
} from "./session-environment.js"

const connectionId = Schema.decodeUnknownSync(ProviderConnectionId)("connection-1")
const providerId = Schema.decodeUnknownSync(ProviderId)("anthropic")
const modelId = Schema.decodeUnknownSync(ProviderModelId)("anthropic/claude-sonnet")

const source = (patch: Partial<Session> = {}): Session => ({
  id: "s_source", repo: "acme/app", branch: "main", title: "Source", status: "idle",
  diff: { added: 0, removed: 0 }, prNumber: null, costUsd: 0, tokens: 0,
  connectionId, providerId, modelId,
  updatedAt: "2026-08-08T00:00:00.000Z", chats: [{ id: "c_source", title: null, connectionId, providerId, modelId, createdAt: "2026-08-08T00:00:00.000Z", updatedAt: "2026-08-08T00:00:00.000Z" }], activeChatId: "c_source", ...patch
})
const target: Environment = { kind: "owned", id: "buildbox", name: "buildbox", platform: { os: "darwin", arch: "arm64" }, capabilities: { version: 1, capabilities: ["session.start"], maxConcurrentSessions: 4, runtime: { versions: CURRENT_RUNTIME_CONTRACTS, toolIds: [], resourceIds: [], targetId: "buildbox" }, providerConnections: [{ id: connectionId, providerId, authKind: "claude-setup-token", status: "authenticated" }] }, state: "online", agentVersion: "2.0.3", lastSeenAt: 1 }

describe("session environment handoff", () => {
  const deps = () => {
    const persist = vi.fn((id: string, environmentId?: string) => Effect.succeed({ ...source(), id, environmentId }))
    const continueSession = vi.fn((session: Session, environmentId?: string) => Effect.succeed({ ...session, id: "s_continuation", environmentId }))
    return { persist, continueSession, environments: () => Effect.succeed([target]) }
  }
  it("re-provisions a pristine session in place", async () => {
    const d = deps(); const result = await Effect.runPromise(setSessionEnvironment(source(), "buildbox", d)); expect(result.id).toBe("s_source"); expect(d.persist).toHaveBeenCalledOnce()
  })
  it("never reassigns a session whose live transcript has not reached persisted counters yet", async () => {
    const d = deps(); const exit = await Effect.runPromiseExit(setSessionEnvironment(source(), "buildbox", d, true)); expect(Exit.isFailure(exit)).toBe(true); expect(d.persist).not.toHaveBeenCalled()
  })
  it("creates a continuation when the source session contains work", async () => {
    const d = deps(); const result = await Effect.runPromise(continueSessionOnEnvironment(source({ diff: { added: 2, removed: 0 } }), "buildbox", d)); expect(result.id).toBe("s_continuation"); expect(d.persist).not.toHaveBeenCalled()
  })
  it("preserves the source session when handoff fails", async () => {
    const base = deps(); const d = { ...base, continueSession: vi.fn(() => Effect.fail(new Error("provision failed"))) }; const exit = await Effect.runPromiseExit(continueSessionOnEnvironment(source({ tokens: 1 }), "buildbox", d)); expect(Exit.isFailure(exit)).toBe(true); expect(base.persist).not.toHaveBeenCalled()
  })
  it("rejects a target missing the authenticated connection", async () => {
    const d = deps(); d.environments = () => Effect.succeed([{ ...target, capabilities: { ...target.capabilities, providerConnections: [] } }]); const exit = await Effect.runPromiseExit(continueSessionOnEnvironment(source(), "buildbox", d)); expect(Exit.isFailure(exit)).toBe(true); expect(d.continueSession).not.toHaveBeenCalled()
  })
  it("requires the exact authenticated connection for a canonical pi session", async () => {
    const canonical = source({ connectionId, providerId, modelId })
    const piTarget: Environment = {
      ...target,
      capabilities: {
        ...target.capabilities,
        runtime: {
          versions: CURRENT_RUNTIME_CONTRACTS,
          toolIds: [],
          resourceIds: [],
          targetId: target.id
        },
        providerConnections: [{
          id: connectionId,
          providerId,
          authKind: "claude-setup-token",
          status: "authenticated"
        }]
      }
    }
    const d = deps()
    d.environments = () => Effect.succeed([piTarget])

    await expect(
      Effect.runPromise(setSessionEnvironment(canonical, "buildbox", d))
    ).resolves.toMatchObject({ environmentId: "buildbox" })

    d.environments = () => Effect.succeed([{
      ...piTarget,
      capabilities: { ...piTarget.capabilities, providerConnections: [] }
    }])
    const exit = await Effect.runPromiseExit(
      setSessionEnvironment(canonical, "buildbox", d)
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("requires the exact runtime contracts and target identity", () => {
    expect(environmentRuntimeIsCurrent(target)).toBe(true)
    expect(environmentRuntimeIsCurrent({
      ...target,
      capabilities: { ...target.capabilities, runtime: undefined }
    })).toBe(false)
    expect(environmentRuntimeIsCurrent({
      ...target,
      capabilities: {
        ...target.capabilities,
        runtime: {
          versions: { ...CURRENT_RUNTIME_CONTRACTS, piSdk: "stale" },
          toolIds: [],
          resourceIds: [],
          targetId: target.id
        }
      }
    })).toBe(false)
    expect(environmentRuntimeIsCurrent({
      ...target,
      capabilities: {
        ...target.capabilities,
        runtime: {
          versions: CURRENT_RUNTIME_CONTRACTS,
          toolIds: [],
          resourceIds: [],
          targetId: "another-target"
        }
      }
    })).toBe(false)
  })
})
