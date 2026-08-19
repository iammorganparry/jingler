import { execFileSync } from "node:child_process"
import { mkdtemp, readdir, rm } from "node:fs/promises"
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
import { FileChangeTracker } from "../file-changes/file-change-tracker.js"
import { PiChildCredentials } from "../subagents/pi-child-credentials.js"
import {
  makeSubagentCapabilityBroker,
  type SubagentCapabilityBroker
} from "../subagents/subagent-capability-broker.js"
import { makePiSessionFactory } from "./pi-session-factory.js"

const roots: string[] = []
const brokers: SubagentCapabilityBroker[] = []
const originalEnvironment = {
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  PI_SUBAGENT_PI_BINARY: process.env.PI_SUBAGENT_PI_BINARY,
  JINGLER_SUBAGENT_PI_CLI: process.env.JINGLER_SUBAGENT_PI_CLI,
  JINGLER_SUBAGENT_CREDENTIAL_ROOT: process.env.JINGLER_SUBAGENT_CREDENTIAL_ROOT,
  JINGLER_SUBAGENT_NODE: process.env.JINGLER_SUBAGENT_NODE
}
afterEach(async () => {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await Promise.all([
    ...brokers.splice(0).map((broker) => Effect.runPromise(broker.close)),
    ...roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  ])
})

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
  runId: "run-1",
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
    const broker = await Effect.runPromise(makeSubagentCapabilityBroker())
    brokers.push(broker)
    const factory = makePiSessionFactory({
      agentDir: join(root, "agent"),
      sessionsDir: join(root, "sessions"),
      credentials,
      childCredentials: new PiChildCredentials(join(root, "child-credentials"), credentials),
      subagentBroker: broker,
      resolveConnection: () => Effect.succeed(connection),
      createSession
    })

    const handle = await Effect.runPromise(factory.create(makeSpec(root), {} as never))
    const received = captured[0]
    expect(handle.id).toBe("/tmp/pi-session.jsonl")
    expect(handle.parentPiSessionId).toBe("pi-session")
    expect(handle.contextWindow).toBe(200_000)
    expect(received?.tools).toEqual(expect.arrayContaining([
      "jingler_ask_question",
      "subagent",
      "subagent_wait"
    ]))
    expect(received?.customTools?.map((tool) => tool.name)).toEqual([
      "jingler_ask_question",
      "jingler_discard_plan",
      "jingler_submit_plan"
    ])
    expect(received?.resourceLoader?.getExtensions().extensions).toEqual([
      expect.objectContaining({ path: expect.stringContaining("pi-subagents") })
    ])
    expect(received?.resourceLoader?.getSystemPrompt()).toContain(
      "Jingler's embedded engineering agent"
    )
    expect(received?.resourceLoader?.getSystemPrompt()).toContain("jingler_ask_question")
    expect(received?.resourceLoader?.getSystemPrompt()).toContain("subagent")
    expect(received?.resourceLoader?.getSystemPrompt()).toContain(
      "Never launch coding CLIs through command_execute"
    )
    expect(received?.sessionManager?.getEntries()).toEqual([
      expect.objectContaining({
        type: "custom_message",
        customType: "jingler.normalized-transcript-seed"
      })
    ])
    await handle.dispose()
  })

  it("forwards the operator's model-native reasoning choice into pi", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-pi-reasoning-"))
    roots.push(root)
    const captured: CreateAgentSessionOptions[] = []
    const factory = makePiSessionFactory({
      agentDir: join(root, "agent"),
      sessionsDir: join(root, "sessions"),
      credentials: new InMemoryProviderCredentialStore(),
      resolveConnection: () => Effect.succeed(connection),
      createSession: async (options) => {
        captured.push(options)
        return { session: fakeSession(), extensionsResult: {} as never }
      }
    })

    await Effect.runPromise(factory.create({
      ...makeSpec(root),
      reasoning: { enabled: true, effort: "high" }
    }, {} as never))

    expect(captured[0]?.thinkingLevel).toBe("high")
  })

  it("disposes the terminal tracker when embedded session creation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-pi-session-failure-"))
    const shadowRoot = await mkdtemp(join(tmpdir(), "jingler-pi-shadow-"))
    roots.push(root, shadowRoot)
    execFileSync("git", ["init", "--quiet", root])
    const credentials = new InMemoryProviderCredentialStore()
    await Effect.runPromise(credentials.write({
      connectionId: connection.id,
      authKind: "api-key",
      access: "secret",
      refresh: null,
      expiresAt: null
    }))
    const tracker = new FileChangeTracker({
      artifactDir: join(root, "artifacts"),
      sessionId: "session-1",
      shadowIndexRoot: shadowRoot
    })
    const factory = makePiSessionFactory({
      agentDir: join(root, "agent"),
      sessionsDir: join(root, "sessions"),
      credentials,
      resolveConnection: () => Effect.succeed(connection),
      terminalTracker: tracker,
      createSession: async () => {
        throw new Error("session unavailable")
      }
    })

    const result = await Effect.runPromise(Effect.either(factory.create(makeSpec(root), {} as never)))

    expect(result._tag).toBe("Left")
    expect(await readdir(shadowRoot)).toEqual([])
  })
})

describe("pi session connection validation", () => {
  it("rejects a mismatch before creating a pi session", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-pi-session-"))
    roots.push(root)
    const other = {
      ...connection,
      id: Schema.decodeUnknownSync(ProviderConnectionId)("other")
    }
    const createSession = vi.fn()
    const factory = makePiSessionFactory({
      agentDir: join(root, "agent"),
      sessionsDir: join(root, "sessions"),
      credentials: new InMemoryProviderCredentialStore(),
      resolveConnection: () => Effect.succeed(other),
      createSession
    })

    const exit = await Effect.runPromiseExit(factory.create(makeSpec(root), {} as never))
    expect(exit.toJSON()).toMatchObject({
      _tag: "Failure",
      cause: { _tag: "Fail", failure: { reason: "authentication" } }
    })
    expect(createSession).not.toHaveBeenCalled()
  })
})
