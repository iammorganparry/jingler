import {
  CURRENT_RUNTIME_CONTRACTS,
  type ProviderConnection,
  type RuntimeDiagnosticMutation,
  type RuntimeDiagnosticSnapshot,
  type StreamEvent
} from "@jingler/core"
import type { PromptManifest } from "../prompt/prompt-compiler.js"
import type { ToolRegistry } from "../tools/tool-registry.js"

export interface RuntimeDiagnosticObserver {
  readonly initial: RuntimeDiagnosticSnapshot
  readonly observe: (event: StreamEvent) => RuntimeDiagnosticSnapshot
}

const mutationStatus = (
  event: Extract<StreamEvent, { readonly _tag: "ToolEnd" }>
): RuntimeDiagnosticMutation["status"] =>
  event.status === "success"
    ? "settled"
    : "failed"

/** Reduce normalized events into metadata only; prompt, arguments, output, and patches never enter. */
export const makeRuntimeDiagnosticObserver = (input: {
  readonly runId: string
  readonly sessionId: string
  readonly connection: ProviderConnection
  readonly mode: string
  readonly manifest: PromptManifest
  readonly registry: ToolRegistry
  readonly now?: () => Date
}): RuntimeDiagnosticObserver => {
  const now = input.now ?? (() => new Date())
  let current: RuntimeDiagnosticSnapshot = {
    runId: input.runId,
    sessionId: input.sessionId,
    connectionId: input.connection.id,
    authRoute: input.connection.authKind,
    accountFingerprint: input.connection.account?.fingerprint ?? null,
    versions: CURRENT_RUNTIME_CONTRACTS,
    promptHash: input.manifest.hash,
    promptSections: input.manifest.sections.map(({ id, hash, estimatedTokens, truncated }) => ({
      id,
      hash,
      estimatedTokens,
      truncated
    })),
    activeToolIds: input.manifest.activeTools,
    mode: input.mode,
    retries: 0,
    mutations: [],
    fileChangeStatuses: [],
    mcpHealth: input.manifest.activeTools
      .filter((id) => id.startsWith("mcp__"))
      .map((name) => ({ name, status: "healthy" as const })),
    terminalCause: null,
    updatedAt: now().toISOString()
  }

  const updateMutation = (
    callId: string,
    update: (existing: RuntimeDiagnosticMutation | undefined) => RuntimeDiagnosticMutation
  ): void => {
    const existing = current.mutations.find((mutation) => mutation.callId === callId)
    const next = update(existing)
    current = {
      ...current,
      mutations: [...current.mutations.filter((mutation) => mutation.callId !== callId), next]
    }
  }

  return {
    initial: current,
    observe: (event) => {
      if (event._tag === "ToolStart") {
        const risk = input.registry.riskFor(event.name)
        if (risk === "mutate" || risk === "execute") {
          updateMutation(event.id, () => ({
            callId: event.id,
            toolId: event.name,
            targetCategory: event.target,
            status: "started",
            fileChangeSetIds: []
          }))
        }
      } else if (event._tag === "ToolEnd") {
        const existing = current.mutations.find((mutation) => mutation.callId === event.id)
        if (existing) {
          updateMutation(event.id, () => ({
            ...existing,
            status: mutationStatus(event),
            fileChangeSetIds: event.fileChanges ? [event.fileChanges.id] : existing.fileChangeSetIds
          }))
        }
        if (event.fileChanges) {
          current = {
            ...current,
            fileChangeStatuses: [...new Set([
              ...current.fileChangeStatuses,
              ...event.fileChanges.changes.map(({ status }) => status)
            ])]
          }
        }
      } else if (event._tag === "RetryScheduled") {
        current = { ...current, retries: Math.max(current.retries, event.attempt) }
      } else if (event._tag === "Done") {
        current = { ...current, terminalCause: "done" }
      } else if (event._tag === "Failed") {
        current = { ...current, terminalCause: "failed" }
      }
      current = { ...current, updatedAt: now().toISOString() }
      return current
    }
  }
}
