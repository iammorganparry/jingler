import { CURRENT_RUNTIME_CONTRACTS, type RuntimeDiagnosticSnapshot } from "@jingler/core"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { RuntimeDiagnostics } from "./runtime-diagnostics.js"

const snapshot: RuntimeDiagnosticSnapshot = {
  runId: "run-1",
  sessionId: "session-1",
  connectionId: "connection-1",
  authRoute: "openai-codex-oauth",
  accountFingerprint: "account-a1b2",
  versions: CURRENT_RUNTIME_CONTRACTS,
  promptHash: "prompt-hash",
  promptSections: [{ id: "safety", hash: "section-hash", estimatedTokens: 40, truncated: false }],
  activeToolIds: ["workspace.read"],
  mode: "ask",
  retries: 0,
  mutations: [{ callId: "call-1", toolId: "workspace.edit", targetCategory: "workspace-file", status: "settled", fileChangeSetIds: ["change-1"] }],
  fileChangeStatuses: ["M"],
  mcpHealth: [{ name: "browser", status: "closed" }],
  terminalCause: "done",
  updatedAt: "2026-08-10T00:00:00.000Z"
}

describe("RuntimeDiagnostics", () => {
  it("exports useful metadata without prompt, argument, patch, or reasoning bodies", async () => {
    const exported = await Effect.runPromise(Effect.gen(function* () {
      yield* RuntimeDiagnostics.record(snapshot)
      return yield* RuntimeDiagnostics.export("run-1")
    }).pipe(Effect.provide(RuntimeDiagnostics.Default)))
    expect(exported).toContain("prompt-hash")
    expect(exported).toContain("workspace.edit")
    expect(exported).not.toContain("diff --git")
    expect(exported).not.toContain("arguments")
    expect(exported).not.toContain("reasoning")
  })
})
