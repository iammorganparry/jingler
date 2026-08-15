import {
  ProviderConnectionId,
  ProviderId,
  type ProviderConnection,
  type StreamEvent
} from "@jingler/core"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ToolRegistry } from "../tools/tool-registry.js"
import { makeRuntimeDiagnosticObserver } from "./runtime-diagnostic-observer.js"

const connection: ProviderConnection = {
  id: Schema.decodeUnknownSync(ProviderConnectionId)("connection-1"),
  providerId: Schema.decodeUnknownSync(ProviderId)("anthropic"),
  authKind: "claude-setup-token",
  account: { fingerprint: "account-1", displayLabel: null },
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
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z"
}

const registry = (): ToolRegistry => {
  const result = new ToolRegistry()
  result.register({
    id: "workspace_write",
    version: "1",
    description: "Write a file",
    input: Schema.Struct({ path: Schema.String, content: Schema.String }),
    risk: "mutate",
    roles: ["conversation"],
    modes: ["ask"],
    timeoutMs: 1_000,
    outputBudget: 1_000,
    cancellable: true,
    idempotency: "keyed",
    execute: async () => ({ ok: true })
  })
  result.setMcpHealth([
    { name: "jingler-browser", status: "healthy" },
    { name: "jingler-memory", status: "failed" }
  ])
  return result
}

const events: ReadonlyArray<StreamEvent> = [
      { _tag: "ToolStart", id: "call-1", name: "workspace_write", target: "src/new.ts" },
      {
        _tag: "ToolEnd",
        id: "call-1",
        status: "success",
        meta: null,
        diff: { added: 1, removed: 0 },
        preview: "+secret source",
        output: "secret output",
        fileChanges: {
          id: "changes-1",
          callId: "call-1",
          changes: [{
            status: "A", path: "src/new.ts", oldPath: null, added: 1, removed: 0,
            binary: false, noNewlineAtEnd: false, beforeBytes: null, afterBytes: 6,
            preview: "+secret source", patchArtifactId: "artifact-1"
          }],
          totals: { added: 1, removed: 0 },
          authoritative: true,
          reconciledAt: "2026-08-10T00:00:00.000Z"
        }
      },
      { _tag: "RetryScheduled", operation: "provider", attempt: 2, maxAttempts: 3, delayMs: 10, message: "retry" },
      { _tag: "Done", costUsd: 0, tokens: 4 }
]

const observer = () => makeRuntimeDiagnosticObserver({
  runId: "run-1",
  sessionId: "session-1",
  connection,
  mode: "ask",
  manifest: {
    contractVersion: "1",
    hash: "prompt-hash",
    estimatedTokens: 12,
    sections: [{
      id: "runtime.safety",
      kind: "safety",
      trust: "immutable",
      hash: "section-hash",
      estimatedTokens: 12,
      truncated: false
    }],
    activeTools: ["workspace_write"]
  },
  registry: registry(),
  now: () => new Date("2026-08-10T00:00:00.000Z")
})

describe("runtime diagnostic observer", () => {
  it("records only redacted contract, mutation, diff, retry, and terminal metadata", () => {
    const diagnosticObserver = observer()
    const result = events.reduce(
      (_, event) => diagnosticObserver.observe(event),
      diagnosticObserver.initial
    )
    expect(result).toMatchObject({
      authRoute: "claude-setup-token",
      promptHash: "prompt-hash",
      retries: 2,
      fileChangeStatuses: ["A"],
      mcpHealth: [
        { name: "jingler-browser", status: "healthy" },
        { name: "jingler-memory", status: "failed" }
      ],
      memory: {
        mutatingExecutions: 0,
        advisories: 0,
        proposals: 0,
        workflowPolls: 0,
        failureCandidates: 0
      },
      terminalCause: "done",
      mutations: [{ callId: "call-1", toolId: "workspace_write", status: "settled", fileChangeSetIds: ["changes-1"] }]
    })
    expect(JSON.stringify(result)).not.toContain("secret")
  })
})
