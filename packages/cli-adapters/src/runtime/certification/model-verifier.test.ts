import {
  CURRENT_RUNTIME_CONTRACTS,
  ProviderConnection,
  ProviderModelId,
  type ProviderConnection as ProviderConnectionType
} from "@jingler/core"
import { Effect, Schema } from "effect"
import { describe, expect, it, vi } from "vitest"
import { InMemoryProviderCredentialStore } from "../auth/credential-store.js"
import { verifyProviderModelBehavior } from "./model-verifier.js"
import { CORE_PI_SCENARIOS } from "./pi-scenarios.js"

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
    const observations = (scenarioId: string) => {
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
            { kind: "event", tag: "Done" }
          ] as const
        case "quality.semantic-references":
          return [
            { kind: "tool-call", tool: "code_intelligence", risk: "read" },
            { kind: "tool-output", tool: "code_intelligence", text: "source.ts reexport.ts" },
            { kind: "event", tag: "Done" }
          ] as const
        case "quality.structural-preview":
          return [
            { kind: "tool-call", tool: "structural_search", risk: "read" },
            { kind: "tool-output", tool: "structural_search", text: '{"matchCount":1}' },
            { kind: "report-text", text: "There is one direct call." },
            { kind: "event", tag: "Done" }
          ] as const
        case "quality.semantic-rename":
          return [
            { kind: "tool-call", tool: "code_intelligence", risk: "read" },
            { kind: "permission", tool: "code_rename", decision: "allow" },
            { kind: "tool-call", tool: "code_rename", risk: "mutate" },
            { kind: "file-change", status: "M", path: "source.ts", oldPath: null },
            { kind: "file-content", path: "source.ts", text: "export const credential = 1" },
            { kind: "file-content", path: "reexport.ts", text: "export { credential as publicToken }" },
            { kind: "file-content", path: "use.ts", text: "const token = 2" },
            { kind: "event", tag: "Done" }
          ] as const
        case "quality.plain-text-skip":
          return [{ kind: "report-text", text: "plain text" }, { kind: "event", tag: "Done" }] as const
        case "remote.contract-compatible":
          return [
            { kind: "event", tag: "RemoteContractAccepted" },
            { kind: "event", tag: "Done" }
          ] as const
        default:
          throw new Error(`Unexpected scenario ${scenarioId}`)
      }
    }
    const runScenario = vi.fn(async (input: { readonly scenarioId: string }) => ({
      scenarioId: input.scenarioId,
      observations: observations(input.scenarioId),
      durationMs: 1,
      tokens: 1,
      costUsd: 0,
      versions: CURRENT_RUNTIME_CONTRACTS
    }))

    const certification = await Effect.runPromise(
      verifyProviderModelBehavior({
        connection: connection(),
        access: "secret-not-for-reports",
        credentials: new InMemoryProviderCredentialStore(),
        modelId: Schema.decodeUnknownSync(ProviderModelId)("anthropic/claude-sonnet"),
        probe: async () => ({
          entitlement: "active",
          planLabel: "Max",
          quotaLabel: null,
          rateLimitLabel: null,
          billingRoute: "subscription",
          observedRoute: "claude-oauth:messages:https://api.anthropic.com"
        }),
        runScenario,
        now: () => new Date("2026-08-12T12:00:00.000Z")
      })
    )

    expect(runScenario).toHaveBeenCalledTimes(CORE_PI_SCENARIOS.length)
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
    expect(certification.results).toHaveLength(CORE_PI_SCENARIOS.length)
    expect(certification.results.every((result) => result.status === "passed")).toBe(true)
  })
})
