import {
  CURRENT_RUNTIME_CONTRACTS,
  ProviderConnection,
  ProviderModelId,
  type ProviderConnection as ProviderConnectionType
} from "@jingler/core"
import { Effect, Schema } from "effect"
import { describe, expect, it, vi } from "vitest"
import { InMemoryProviderCredentialStore } from "../auth/credential-store.js"
import {
  evaluateProviderModelBehavior,
  verifyProviderModelBehavior,
  type LiveHarnessRunInput
} from "./model-verifier.js"

const connection = (): ProviderConnectionType =>
  Schema.decodeUnknownSync(ProviderConnection)({
    id: "claude-max",
    providerId: "anthropic",
    authKind: "claude-setup-token",
    account: { fingerprint: "account", displayLabel: "Claude Max" },
    targetId: "desktop",
    status: "authenticated",
    subscription: {
      entitlement: "active",
      planLabel: "Max",
      expiresAt: null,
      quotaLabel: null,
      rateLimitLabel: null,
      confirmedBillingRoute: "subscription"
    },
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z"
  })

const coreObservations = (scenarioId: string) => {
  switch (scenarioId) {
    case "lifecycle.complete":
      return [{ kind: "event", tag: "Started" }, { kind: "event", tag: "Done" }] as const
    case "permission.denied-edit":
      return [
        { kind: "permission", tool: "workspace_edit", decision: "deny" },
        { kind: "event", tag: "Done" }
      ] as const
    case "auth.route-pinned":
      return [
        { kind: "auth-route", route: "claude-setup-token" },
        { kind: "event", tag: "Done" }
      ] as const
    case "diff.create-edit-delete-rename":
      return [
        { kind: "file-change", status: "A", path: "src/new.ts", oldPath: null },
        { kind: "file-change", status: "M", path: "src/edit.ts", oldPath: null },
        { kind: "file-change", status: "D", path: "src/delete.ts", oldPath: null },
        { kind: "file-change", status: "R", path: "src/renamed.ts", oldPath: "src/old.ts" },
        { kind: "event", tag: "Done" }
      ] as const
    case "capability.managed-resources":
      return [
        { kind: "tool-call", tool: "jingler_list_resources", risk: "read" },
        { kind: "tool-call", tool: "jingler_load_resource", risk: "read" },
        { kind: "tool-call", tool: "mcp__managed__write_file", risk: "execute" },
        { kind: "file-change", status: "A", path: "src/mcp-created.ts", oldPath: null },
        { kind: "resource", name: "managed-mcp", state: "opened" },
        { kind: "resource", name: "managed-mcp", state: "closed" },
        { kind: "event", tag: "Done" }
      ] as const
    case "structured.question-plan":
      return [
        { kind: "event", tag: "QuestionRequested" },
        { kind: "event", tag: "PlanProposed" },
        { kind: "event", tag: "Done" }
      ] as const
    case "remote.contract-compatible":
      return [
        { kind: "event", tag: "RemoteContractAccepted" },
        { kind: "event", tag: "Done" }
      ] as const
    default:
      throw new Error(`Unexpected scenario ${scenarioId}`)
  }
}

const passingCoreRunScenario = () =>
  vi.fn(async (input: { readonly scenarioId: string }) => ({
    scenarioId: input.scenarioId,
    observations: coreObservations(input.scenarioId),
    durationMs: 1,
    tokens: 1,
    costUsd: 0,
    versions: CURRENT_RUNTIME_CONTRACTS
  }))

const subscriptionProbe = async () => ({
  entitlement: "active" as const,
  planLabel: "Max",
  quotaLabel: null,
  rateLimitLabel: null,
  billingRoute: "subscription" as const,
  observedRoute: "claude-oauth:messages:https://api.anthropic.com"
})

describe("provider model behavior verification", () => {
  it("rejects a provider-qualified model from another provider before traffic", async () => {
    const probe = vi.fn()
    const runScenario = vi.fn()

    const error = await Effect.runPromise(
      verifyProviderModelBehavior({
        connection: connection(),
        access: "secret-not-for-reports",
        credentials: new InMemoryProviderCredentialStore(),
        modelId: Schema.decodeUnknownSync(ProviderModelId)("openai-codex/gpt-5.3-codex"),
        probe,
        runScenario
      }).pipe(Effect.flip)
    )

    expect(error).toMatchObject({
      _tag: "ModelVerificationError",
      message: "Model openai-codex/gpt-5.3-codex does not belong to provider anthropic"
    })
    expect(probe).not.toHaveBeenCalled()
    expect(runScenario).not.toHaveBeenCalled()
  })

  it("rejects subscription verification before scenarios when the observed route uses API billing", async () => {
    const runScenario = vi.fn()

    const error = await Effect.runPromise(
      verifyProviderModelBehavior({
          connection: connection(),
          access: "secret-not-for-reports",
          credentials: new InMemoryProviderCredentialStore(),
          modelId: Schema.decodeUnknownSync(ProviderModelId)("anthropic/claude-sonnet"),
          probe: async () => ({
            entitlement: "active",
            planLabel: null,
            quotaLabel: null,
            rateLimitLabel: null,
            billingRoute: "api",
            observedRoute: "api-key:messages"
          }),
        runScenario
      }).pipe(Effect.flip)
    )

    expect(error).toMatchObject({
      _tag: "ModelVerificationError",
      message: "claude-max did not confirm its subscription billing route"
    })
    expect(runScenario).not.toHaveBeenCalled()
  })

  it("aborts an entitlement probe that exceeds its deadline", async () => {
    let aborted = false
    const probe = ({ signal }: { readonly signal: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true
          reject(new Error("aborted"))
        }, { once: true })
      })

    const error = await Effect.runPromise(
      verifyProviderModelBehavior({
        connection: connection(),
        access: "secret-not-for-reports",
        credentials: new InMemoryProviderCredentialStore(),
        modelId: Schema.decodeUnknownSync(ProviderModelId)("anthropic/claude-sonnet"),
        probe,
        entitlementTimeoutMs: 10
      }).pipe(Effect.flip)
    )

    expect(error).toMatchObject({
      _tag: "ModelVerificationError",
      message: "claude-max entitlement probe timed out"
    })
    expect(aborted).toBe(true)
  })

  it("certifies the exact connection route only after every core scenario passes", async () => {
    const runScenario = passingCoreRunScenario()

    const certification = await Effect.runPromise(
      verifyProviderModelBehavior({
        connection: connection(),
        access: "secret-not-for-reports",
        credentials: new InMemoryProviderCredentialStore(),
        modelId: Schema.decodeUnknownSync(ProviderModelId)("anthropic/claude-sonnet"),
        probe: subscriptionProbe,
        runScenario,
        now: () => new Date("2026-08-12T12:00:00.000Z")
      })
    )

    expect(runScenario).toHaveBeenCalledTimes(7)
    expect(certification).toMatchObject({
      providerId: "anthropic",
      modelId: "anthropic/claude-sonnet",
      authRoute: {
        kind: "claude-setup-token",
        observedRoute: "claude-oauth:messages:https://api.anthropic.com",
        subscription: true,
        entitlementConfirmed: true,
        apiBillingFallbackObserved: false
      },
      capabilityProfiles: ["core"],
      certifiedAt: "2026-08-12T12:00:00.000Z"
    })
    expect(certification.results).toHaveLength(7)
    expect(certification.results.every((result) => result.status === "passed")).toBe(true)
  })
})

describe("live harness pass@k", () => {
  const planTrace = (input: { readonly completed: boolean }) => ({
    scenarioId: "plan.task-status-live",
    observations: input.completed
      ? ([
          { kind: "plan-task-status", stageId: "01", taskId: "01.a", status: "completed" },
          { kind: "plan-task-status", stageId: "01", taskId: "01.b", status: "completed" },
          { kind: "event", tag: "Done" }
        ] as const)
      : ([
          { kind: "plan-task-status", stageId: "01", taskId: "01.a", status: "pending" },
          { kind: "plan-task-status", stageId: "01", taskId: "01.b", status: "pending" },
          { kind: "event", tag: "Done" }
        ] as const),
    durationMs: 1,
    tokens: 10,
    costUsd: 0.01,
    versions: CURRENT_RUNTIME_CONTRACTS
  })

  const evaluate = (samples: ReadonlyArray<boolean>) => {
    const run = vi.fn(async (input: LiveHarnessRunInput) =>
      planTrace({ completed: samples[input.sample] ?? false })
    )
    return Effect.runPromise(
      evaluateProviderModelBehavior({
        connection: connection(),
        access: "secret-not-for-reports",
        credentials: new InMemoryProviderCredentialStore(),
        modelId: Schema.decodeUnknownSync(ProviderModelId)("anthropic/claude-sonnet"),
        probe: subscriptionProbe,
        runScenario: passingCoreRunScenario(),
        liveHarness: { samples: samples.length, run },
        now: () => new Date("2026-08-12T12:00:00.000Z")
      })
    ).then((result) => ({ result, run }))
  }

  it("passes on strict majority and reports the mean sample score", async () => {
    const { result, run } = await evaluate([true, false, true])
    expect(run).toHaveBeenCalledTimes(3)
    const aggregated = result.certification.results.find(
      (candidate) => candidate.scenarioId === "plan.task-status-live"
    )
    expect(aggregated).toMatchObject({ status: "passed" })
    // 4 checks (3 required + 1 forbidden); the failing sample missed 2 of 4
    // → 1/2; mean of (1, 1/2, 1) = 5/6.
    expect(aggregated?.score).toBeCloseTo(5 / 6)
    // Per-sample cost survives aggregation so the eval cost ceiling sees it.
    expect(aggregated?.costUsd).toBeCloseTo(0.03)
    expect(aggregated?.failures).toEqual([
      "sample 2: missing plan-task-status:01:01.a:completed",
      "sample 2: missing plan-task-status:01:01.b:completed"
    ])
    // Sample traces ride along as evidence without becoming their own results.
    expect(
      result.traces.filter((trace) => trace.scenarioId === "plan.task-status-live")
    ).toHaveLength(3)
    // 7 core + 1 aggregated live-plan + 2 aggregated selection scenarios.
    expect(result.certification.results).toHaveLength(10)
  })

  it("fails without a strict majority and keeps the core certification intact", async () => {
    const { result } = await evaluate([true, false, false])
    const aggregated = result.certification.results.find(
      (candidate) => candidate.scenarioId === "plan.task-status-live"
    )
    expect(aggregated).toMatchObject({ status: "failed" })
    // Live behavior reporting never revokes a model's core capability pass.
    expect(result.certification.capabilityProfiles).toEqual(["core"])
  })
})
