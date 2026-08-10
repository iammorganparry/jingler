import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  AgentSession,
  CreateAgentSessionOptions,
  CreateAgentSessionResult
} from "@earendil-works/pi-coding-agent"
import {
  CURRENT_RUNTIME_CONTRACTS,
  ProviderConnection,
  ProviderConnectionId,
  ProviderModelId,
  type PiRunSpec
} from "@jingler/core"
import { Effect, Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { InMemoryProviderCredentialStore } from "../auth/credential-store.js"
import { makePiSessionFactory } from "./pi-session-factory.js"

const roots: string[] = []
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
)

const connection = Schema.decodeUnknownSync(ProviderConnection)({
  id: "anthropic-api",
  providerId: "anthropic",
  authKind: "api-key",
  account: null,
  targetId: "desktop",
  status: "authenticated",
  subscription: {
    entitlement: "active",
    planLabel: null,
    expiresAt: null,
    quotaLabel: null,
    rateLimitLabel: null,
    confirmedBillingRoute: "api"
  },
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z"
})

const message = {
  id: "message-1",
  role: "user" as const,
  parts: [{ _tag: "Text" as const, text: "Remember the migration boundary." }],
  streaming: false,
  createdAt: "2026-08-10T00:00:00.000Z"
}

const makeSpec = (cwd: string): PiRunSpec => ({
  sessionId: "session-1",
  chatId: "chat-1",
  connectionId: Schema.decodeUnknownSync(ProviderConnectionId)("anthropic-api"),
  modelId: Schema.decodeUnknownSync(ProviderModelId)("anthropic/claude-haiku-4-5"),
  role: "conversation",
  mode: "ask",
  cwd,
  prompt: "continue",
  priorMessages: [message],
  piSessionId: null,
  seed: { reason: "migration", messages: [message] },
  targetCapabilities: {
    versions: CURRENT_RUNTIME_CONTRACTS,
    toolIds: [],
    resourceIds: [],
    targetId: "desktop"
  }
})

const fakeSession = (): AgentSession =>
  ({
    sessionFile: "/tmp/pi-session.jsonl",
    sessionId: "pi-session",
    subscribe: vi.fn(() => vi.fn()),
    prompt: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    dispose: vi.fn(),
    getSessionStats: () => ({ cost: 0, tokens: { total: 0 } })
  }) as unknown as AgentSession

describe("pi session creation", () => {
  it("pins credentials, compiles a locked prompt, and seeds visible history once", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-pi-session-"))
    roots.push(root)
    const credentials = new InMemoryProviderCredentialStore()
    await Effect.runPromise(
      credentials.write({
        connectionId: connection.id,
        authKind: "api-key",
        access: "secret",
        refresh: null,
        expiresAt: null
      })
    )
    const captured: CreateAgentSessionOptions[] = []
    const createSession = async (
      options: CreateAgentSessionOptions
    ): Promise<CreateAgentSessionResult> => {
      captured.push(options)
      return { session: fakeSession(), extensionsResult: {} as never }
    }
    const factory = makePiSessionFactory({
      agentDir: join(root, "agent"),
      sessionsDir: join(root, "sessions"),
      credentials,
      resolveConnection: () => Effect.succeed(connection),
      createSession
    })

    const handle = await Effect.runPromise(
      factory.create(makeSpec(root), {} as never)
    )
    const received = captured[0]
    expect(handle.id).toBe("/tmp/pi-session.jsonl")
    expect(received?.tools).toContain("jingler_ask_question")
    expect(received?.customTools?.map((tool) => tool.name)).toEqual([
      "jingler_ask_question"
    ])
    expect(received?.resourceLoader?.getExtensions().extensions).toEqual([])
    expect(received?.resourceLoader?.getSystemPrompt()).toContain(
      "Jingler's embedded engineering agent"
    )
    expect(received?.resourceLoader?.getSystemPrompt()).toContain(
      "jingler_ask_question"
    )
    expect(received?.sessionManager?.getEntries()).toEqual([
      expect.objectContaining({
        type: "custom_message",
        customType: "jingler.normalized-transcript-seed"
      })
    ])
  })

})

describe("pi session connection validation", () => {
  it("rejects a mismatch before creating a pi session", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-pi-session-"))
    roots.push(root)
    const other = { ...connection, id: Schema.decodeUnknownSync(ProviderConnectionId)("other") }
    const createSession = vi.fn()
    const factory = makePiSessionFactory({
      agentDir: join(root, "agent"),
      sessionsDir: join(root, "sessions"),
      credentials: new InMemoryProviderCredentialStore(),
      resolveConnection: () => Effect.succeed(other),
      createSession
    })

    const exit = await Effect.runPromiseExit(
      factory.create(makeSpec(root), {} as never)
    )
    expect(exit.toJSON()).toMatchObject({
      _tag: "Failure",
      cause: { _tag: "Fail", failure: { reason: "authentication" } }
    })
    expect(createSession).not.toHaveBeenCalled()
  })
})
