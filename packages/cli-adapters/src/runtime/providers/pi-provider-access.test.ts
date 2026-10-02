import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import type { Api, Model } from "@earendil-works/pi-ai"
import { ProviderConnection, ProviderConnectionId } from "@jingler/core"
import { fileURLToPath } from "node:url"
import { Effect, Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { InMemoryProviderCredentialStore } from "../auth/credential-store.js"
import {
  classifyObservedBillingRoute,
  discoverPiModels,
  isModelUnsupportedError,
  modelReasoningCapabilities,
  registerClaudeCliProvider,
  registerJinglerModels,
} from "./pi-provider-access.js"

const codexBinary = fileURLToPath(new URL("../codex/fixtures/app-server.mjs", import.meta.url))

afterEach(() => vi.unstubAllEnvs())

describe("Jingler model additions", () => {
  it("adds GPT-6 Astra to the configured Codex route", async () => {
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false })
    runtime.registerProvider("openai-codex", { baseUrl: "https://codex-proxy.example.com" })

    await registerJinglerModels(runtime, { binary: codexBinary })

    expect(runtime.getModel("openai-codex", "gpt-6-astra")).toMatchObject({
      baseUrl: "https://codex-proxy.example.com",
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }
    })
  })

  it("registers models advertised by the installed Codex CLI for PI execution", async () => {
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false })
    await registerJinglerModels(runtime, {
      binary: codexBinary,
      environment: { ...process.env, CODEX_HOME: "latest-models" }
    })

    expect(runtime.getModel("openai-codex", "gpt-6.1-sol")).toMatchObject({
      name: "GPT-6.1 Sol",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      contextWindow: 272_000,
      maxTokens: 128_000,
      reasoning: true,
      input: ["text", "image"]
    })
  })

  it("discovers CLI-advertised models through a PI Codex connection", async () => {
    vi.stubEnv("JINGLER_CODEX_BINARY", codexBinary)
    vi.stubEnv("CODEX_HOME", "latest-models")
    const connectionId = ProviderConnectionId.make("codex-cli-models")
    const credentials = new InMemoryProviderCredentialStore()
    await Effect.runPromise(credentials.write({
      connectionId,
      authKind: "openai-codex-oauth",
      access: "fixture-access",
      refresh: "fixture-refresh",
      expiresAt: Date.now() + 60_000
    }))
    const connection = Schema.decodeUnknownSync(ProviderConnection)({
      id: connectionId,
      providerId: "openai-codex",
      authKind: "openai-codex-oauth",
      account: null,
      targetId: "desktop",
      status: "authenticated",
      subscription: {
        entitlement: "active",
        planLabel: null,
        expiresAt: null,
        quotaLabel: null,
        rateLimitLabel: null,
        confirmedBillingRoute: "subscription"
      },
      createdAt: "2026-10-02T00:00:00.000Z",
      updatedAt: "2026-10-02T00:00:00.000Z"
    })

    const models = await Effect.runPromise(
      discoverPiModels(credentials, connection, new AbortController().signal)
    )
    expect(models).toContainEqual(expect.objectContaining({
      id: "openai-codex/gpt-6.1-sol",
      label: "GPT-6.1 Sol"
    }))
  })

  it("installs the Claude CLI stream only for an explicit subscription route", async () => {
    const apiRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false })
    await registerJinglerModels(apiRuntime, { binary: codexBinary })
    expect(apiRuntime.getRegisteredProviderConfig("anthropic")?.streamSimple).toBeUndefined()

    const subscriptionRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false })
    registerClaudeCliProvider(subscriptionRuntime, { cwd: "/tmp" })
    expect(subscriptionRuntime.getRegisteredProviderConfig("anthropic")?.streamSimple)
      .toBeTypeOf("function")
    expect(subscriptionRuntime.getModel("anthropic", "claude-opus-5-5")).toMatchObject({
      name: "Claude Opus 5.5",
      contextWindow: 1_000_000,
      maxTokens: 128_000
    })
    expect(subscriptionRuntime.getModel("anthropic", "opus")).toMatchObject({
      name: "Claude Opus (latest)"
    })
  })
})

describe("observed provider billing routes", () => {
  it("confirms Codex subscription only on the ChatGPT backend", () => {
    expect(classifyObservedBillingRoute("openai-codex-oauth", {
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api"
    })).toBe("subscription")
    expect(classifyObservedBillingRoute("openai-codex-oauth", {
      provider: "openai-codex",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1"
    })).toBeNull()
  })

  it("never treats Anthropic API traffic as the Claude CLI subscription route", () => {
    expect(classifyObservedBillingRoute("claude-setup-token", {
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com"
    })).toBeNull()
  })
})

describe("entitlement probe model fallback", () => {
  it("treats a plan-excluded model as a reason to try the next model", () => {
    expect(isModelUnsupportedError(
      '{"detail":"The \'gpt-5.3-codex-spark\' model is not supported when using Codex with a ChatGPT account."}'
    )).toBe(true)
  })

  it("still fails the probe on account-level errors", () => {
    expect(isModelUnsupportedError("401 Unauthorized: invalid token")).toBe(false)
    expect(isModelUnsupportedError("You have exceeded your quota")).toBe(false)
  })
})

describe("supportedReasoningEfforts", () => {
  it("uses pi's model-specific thinking map including adaptive Claude levels", () => {
    const model = {
      reasoning: true,
      thinkingLevelMap: {
        minimal: null,
        xhigh: "xhigh",
        max: "max"
      }
    } as Model<Api>

    expect(modelReasoningCapabilities(model)).toEqual({
      reasoning: ["low", "medium", "high", "xhigh", "max"],
      reasoningCanDisable: true,
      reasoningDefault: "medium"
    })
  })

  it("returns no effort controls for a non-reasoning model", () => {
    expect(modelReasoningCapabilities({ reasoning: false } as Model<Api>)).toEqual({
      reasoning: [],
      reasoningCanDisable: true
    })
  })

  it("preserves pi's model-specific ability to disable reasoning", () => {
    expect(modelReasoningCapabilities({
      reasoning: true,
      thinkingLevelMap: { off: null, medium: null }
    } as Model<Api>)).toEqual({
      reasoning: ["minimal", "low", "high"],
      reasoningCanDisable: false,
      reasoningDefault: "high"
    })
  })
})
