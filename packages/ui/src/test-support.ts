import {
  ProviderCatalog,
  type ReasoningEffort,
  Session as SessionSchema,
  type Session,
  type SessionCheckout
} from "@jingler/core"
import { Schema } from "effect"

/** One certified provider connection for component tests and stories. */
export const testProviderCatalog = (
  reasoning: ReadonlyArray<ReasoningEffort> = [],
  reasoningCanDisable = true,
  reasoningDefault: ReasoningEffort | undefined = reasoning.includes("medium")
    ? "medium"
    : undefined
) => Schema.decodeUnknownSync(ProviderCatalog)({
  refreshedAt: "2026-08-10T00:00:00.000Z",
  stale: false,
  connections: [{
    connection: {
      id: "test-connection",
      providerId: "openai-codex",
      authKind: "openai-codex-oauth",
      account: { fingerprint: "test-account", displayLabel: "Test account" },
      targetId: "local",
      status: "authenticated",
      subscription: {
        entitlement: "active",
        planLabel: "Plus",
        expiresAt: null,
        quotaLabel: null,
        rateLimitLabel: null,
        confirmedBillingRoute: "subscription"
      },
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z"
    },
    models: [{
      providerId: "openai-codex",
      id: "openai-codex/gpt-test",
      label: "GPT Test",
      capabilities: {
        contextWindow: 200_000,
        reasoning,
        reasoningCanDisable,
        reasoningDefault,
        vision: false
      },
      verification: "certified",
      selectable: true,
      certificationKey: "test-certification"
    }]
  }]
})

/**
 * A Session with sensible defaults, for tests and stories.
 *
 * Hoisted out of the individual suites because the same ~20-line literal was
 * being copy-pasted into every file that renders a session — which meant a
 * change to the `Session` shape had to be applied in five places, and the
 * defaults had already started to drift apart.
 *
 * `updatedAt` is a fixed date, never `new Date()`: relative-time rendering
 * ("2 hours ago") must not depend on when the suite happens to run.
 */
/** Per-repo fields callers may still pass flat; they are folded into the primary checkout. */
export type CheckoutFields = Partial<Omit<SessionCheckout, "id">>

/**
 * Decode a wire-shaped fixture (flat per-repo fields, or explicit checkouts)
 * through the production `Session` schema, so fixtures migrate exactly as
 * persisted sessions do and invalid ones fail loudly.
 */
export const foldCheckout = (flat: object): Session =>
  Schema.decodeUnknownSync(SessionSchema)({ repo: "", branch: "", prNumber: null, ...flat })

export const testSession = (over: Partial<Session> & CheckoutFields & { id: string }): Session =>
  foldCheckout({
    repo: "gtm-grid",
    branch: `chore/${over.id}`,
    title: over.id,
    status: "idle",
    connectionId: "test-connection",
    providerId: "openai-codex",
    modelId: "openai-codex/gpt-test",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-16T00:00:00.000Z",
    chats: [{
      id: `c_${over.id}_1`,
      title: null,
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z"
    }],
    activeChatId: `c_${over.id}_1`,
    worktreePath: `/tmp/${over.id}`,
    baseBranch: "main",
    mode: "auto",
    ...over
  })
