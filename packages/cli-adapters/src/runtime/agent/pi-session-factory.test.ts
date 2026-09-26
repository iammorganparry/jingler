import { execFileSync } from "node:child_process"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type AgentSession,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
} from "@earendil-works/pi-coding-agent"
import {
  CURRENT_RUNTIME_CONTRACTS,
  ProviderConnection,
  ProviderConnectionId,
  ProviderModelId,
  piEndpointId,
  type AgentRunSpec
} from "@jingler/core"
import { Effect, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { InMemoryProviderCredentialStore } from "../auth/credential-store.js"
import { FileChangeTracker } from "../file-changes/file-change-tracker.js"
import { PiChildCredentials } from "../subagents/pi-child-credentials.js"
import { registerCodeIntelligenceTools } from "../tools/code-intelligence-tools.js"
import { ToolRegistry } from "../tools/tool-registry.js"
import { registerWorkspaceInspectionTools } from "../tools/workspace-tools.js"
import {
  makeSubagentCapabilityBroker,
  type SubagentCapabilityBroker
} from "../subagents/subagent-capability-broker.js"
import {
  makePiSessionFactory
} from "./pi-session-factory.js"

const roots: string[] = []
const brokers: SubagentCapabilityBroker[] = []
const originalEnvironment = {
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  JINGLER_SUBAGENT_PROCESS_ISOLATION: process.env.JINGLER_SUBAGENT_PROCESS_ISOLATION,
  JINGLER_SUBAGENT_CREDENTIAL_ROOT: process.env.JINGLER_SUBAGENT_CREDENTIAL_ROOT,
  JINGLER_SUBAGENT_NODE: process.env.JINGLER_SUBAGENT_NODE
}
beforeEach(() => {
  for (const name of Object.keys(originalEnvironment)) delete process.env[name]
})
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

const makeSpec = (cwd: string): AgentRunSpec => ({
  runId: "run-1",
  sessionId: "session-1",
  chatId: "chat-1",
  runtimeId: "pi",
  endpointId: piEndpointId("desktop", connection.id),
  connectionId: Schema.decodeUnknownSync(ProviderConnectionId)("anthropic-api"),
  modelId: Schema.decodeUnknownSync(ProviderModelId)("anthropic/claude-haiku-4-5"),
  role: "conversation",
  mode: "ask",
  cwd,
  prompt: "continue",
  priorMessages: [message],
  continuation: null,
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
    bindExtensions: vi.fn(async () => undefined),
    prompt: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    dispose: vi.fn(),
    getSessionStats: () => ({ cost: 0, tokens: { total: 0 } })
  }) as unknown as AgentSession

describe("pi session creation", () => {
  it("uses only registry-owned planning tools with tracked Auto tools in plan mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-planning-session-")); roots.push(root)
    const captured: CreateAgentSessionOptions[] = []
    const registry = new ToolRegistry()
    for (const id of ["auto_only", "plannotator_submit_plan", "plannotator_update_plan"]) registry.register({
      id, version: "1", description: "Shared registry tool", input: Schema.Struct({}), risk: "read", roles: ["conversation"], modes: ["auto"],
      timeoutMs: 1000, outputBudget: 1000, cancellable: true, idempotency: "safe", execute: async () => null
    })
    const factory = makePiSessionFactory({ agentDir: join(root, "agent"), sessionsDir: join(root, "sessions"),
      credentials: new InMemoryProviderCredentialStore(), resolveConnection: () => Effect.succeed(connection), toolRegistry: registry,
      createSession: async (options) => { captured.push(options); return { session: fakeSession(), extensionsResult: {} as never } }
    })
    await Effect.runPromise(factory.create({ ...makeSpec(root), role: "plan", mode: "plan" }, {} as never))
    expect(captured[0]?.tools).toEqual(["auto_only", "plannotator_submit_plan", "plannotator_update_plan"])
    expect(captured[0]?.customTools?.map(({ name }) => name)).toEqual(captured[0]?.tools)
    expect(captured[0]?.resourceLoader?.getSystemPrompt()).toContain("- plannotator_submit_plan: Shared registry tool")
  })

  it.each(["api-key", "claude-setup-token"] as const)(
    "selects the %s Claude route when both connections exist",
    async (authKind) => {
      const root = await mkdtemp(join(tmpdir(), "jingler-claude-routes-"))
      roots.push(root)
      const subscription = Schema.decodeUnknownSync(ProviderConnection)({
        ...connection,
        id: "claude-subscription",
        authKind: "claude-setup-token",
        subscription: {
          ...connection.subscription,
          confirmedBillingRoute: "subscription",
          observedRoute: "claude-cli:subscription"
        }
      })
      const credentials = new InMemoryProviderCredentialStore()
      for (const route of [connection, subscription]) {
        await Effect.runPromise(credentials.write({
          connectionId: route.id,
          authKind: route.authKind,
          access: route.authKind === "api-key" ? "test-api-key" : "claude-cli",
          refresh: null,
          expiresAt: null
        }))
      }
      const selected = authKind === "api-key" ? connection : subscription
      const captured: CreateAgentSessionOptions[] = []
      const factory = makePiSessionFactory({
        agentDir: join(root, "agent"),
        sessionsDir: join(root, "sessions"),
        credentials,
        resolveConnection: () => Effect.succeed(selected),
        createSession: async (options) => {
          captured.push(options)
          return { session: fakeSession(), extensionsResult: {} as never }
        }
      })

      await Effect.runPromise(factory.create({
        ...makeSpec(root), connectionId: selected.id
      }, {} as never))

      const stream = captured[0]?.modelRuntime
        ?.getRegisteredProviderConfig("anthropic")?.streamSimple
      if (authKind === "api-key") expect(stream).toBeUndefined()
      else expect(stream).toBeTypeOf("function")
      expect(captured[0]?.model?.provider).toBe("anthropic")
    }
  )

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
    const session = fakeSession()
    const createSession = async (
      options: CreateAgentSessionOptions
    ): Promise<CreateAgentSessionResult> => {
      captured.push(options)
      return { session, extensionsResult: {} as never }
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

    const handle = await Effect.runPromise(factory.create({ ...makeSpec(root), ponytailMode: "lite" }, {} as never))
    const received = captured[0]
    expect(handle.id).toBe("/tmp/pi-session.jsonl")
    expect(handle.parentRuntimeSessionId).toBe("pi-session")
    expect(handle.contextWindow).toBe(200_000)
    expect(received?.tools).toEqual(expect.arrayContaining([
      "jingler_ask_question",
      "subagent",
      "bg_wait"
    ]))
    expect(received?.customTools?.map((tool) => tool.name)).toEqual([
      "jingler_ask_question",
      "jingler_publish_explanation",
      "jingler_complete_session"
    ])
    expect(received?.resourceLoader?.getExtensions().extensions).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringContaining("pi-subagents") })
    ]))
    expect(session.bindExtensions).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "rpc", uiContext: expect.any(Object) })
    )
    expect(received?.resourceLoader?.getSystemPrompt()).toContain("PONYTAIL MODE ACTIVE — level: lite")
    expectLockedSystemPrompt(received?.resourceLoader?.getSystemPrompt())
    expect(received?.sessionManager?.getEntries()).toEqual([
      expect.objectContaining({
        type: "custom_message",
        customType: "jingler.normalized-transcript-seed"
      })
    ])
    await handle.prompt("Read this form", [{
      id: "image-1",
      name: "form.png",
      mediaType: "image/png",
      data: "aGVsbG8="
    }])
    expect(session.prompt).toHaveBeenCalledWith("Read this form", {
      images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]
    })
    await handle.dispose()
  })

  it("bridges a selectively registered semantic tool without enabling ambient pi tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-pi-code-tools-"))
    roots.push(root)
    const captured: CreateAgentSessionOptions[] = []
    const registry = new ToolRegistry()
    registerCodeIntelligenceTools(registry, root)
    registerWorkspaceInspectionTools(registry, root, {
      listFiles: () => Effect.succeed([]),
      readTextFile: (_cwd, path) => Effect.succeed({
        path, text: "", language: null, revision: "sha256:test"
      }),
      executeReadOnly: (_cwd, program, args) => Effect.succeed({
        command: [program, ...args].join(" "), exitCode: 0, stdout: "", stderr: ""
      })
    })
    const factory = makePiSessionFactory({
      agentDir: join(root, "agent"),
      sessionsDir: join(root, "sessions"),
      credentials: new InMemoryProviderCredentialStore(),
      resolveConnection: () => Effect.succeed(connection),
      toolRegistry: registry,
      createSession: async (options) => {
        captured.push(options)
        return { session: fakeSession(), extensionsResult: {} as never }
      }
    })

    await Effect.runPromise(factory.create({
      ...makeSpec(root),
      role: "plan",
      mode: "read-only"
    }, {} as never))

    expect(captured[0]?.tools).toContain("code_intelligence")
    expect(captured[0]?.tools).toContain("command_inspect")
    expect(captured[0]?.customTools?.map(({ name }) => name)).toContain("code_intelligence")
    expect(captured[0]?.customTools?.map(({ name }) => name)).toContain("command_inspect")
    expect(captured[0]?.tools).not.toContain("command_execute")
    expect(captured[0]?.tools).not.toContain("bash")
    expect(captured[0]?.tools).not.toContain("lsp")
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

const expectLockedSystemPrompt = (prompt: string | undefined): void => {
  expect(prompt).toContain("Jingler's embedded engineering agent")
  expect(prompt).toContain("jingler_ask_question")
  expect(prompt).toContain("subagent")
  expect(prompt).toContain("Never launch coding CLIs through command_execute")
  expect(prompt).toContain("Self-implementation stays in Main")
  expect(prompt).toContain("never use a child named main as its proxy")
  expect(prompt).toContain("Select a catalog agent and name every child")
  expect(prompt).toContain("reserve workflowScript for two or more children")
  expect(prompt).not.toContain("scout (fast codebase recon)")
}
