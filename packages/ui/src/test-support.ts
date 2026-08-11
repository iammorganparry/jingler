import {
  ProviderCatalog,
  type ReasoningEffort,
  type Session
} from "@jingler/core"
import { Schema } from "effect"

/** One certified provider connection for component tests and stories. */
export const testProviderCatalog = (
  reasoning: ReadonlyArray<ReasoningEffort> = []
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
      capabilities: { contextWindow: 200_000, reasoning, vision: false },
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
export const testSession = (over: Partial<Session> & { id: string }): Session =>
  ({
    repo: "gtm-grid",
    branch: `chore/${over.id}`,
    title: over.id,
    status: "idle",
    cli: "claude",
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
  }) as Session
