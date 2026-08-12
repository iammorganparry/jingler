import {
  CURRENT_RUNTIME_CONTRACTS,
  type ProviderConnection,
  type RuntimeDiagnosticMutation,
  type RuntimeDiagnosticSnapshot,
  type StreamEvent
} from "@jingler/core"
import type { PromptManifest } from "../prompt/prompt-compiler.js"
import type { ToolRegistry } from "../tools/tool-registry.js"

interface ObserverInput {
  readonly runId: string
  readonly sessionId: string
  readonly connection: ProviderConnection
  readonly mode: string
  readonly manifest: PromptManifest
  readonly registry: ToolRegistry
  readonly now?: () => Date
}

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

const mcpHealth = (
  registry: ToolRegistry,
  activeTools: ReadonlyArray<string>
): RuntimeDiagnosticSnapshot["mcpHealth"] => {
  const reported = registry.mcpHealth()
  return reported.length > 0
    ? reported
    : activeTools
        .filter((id) => id.startsWith("mcp__"))
        .map((name) => ({ name, status: "healthy" as const }))
}

const initialSnapshot = (
  input: ObserverInput,
  now: () => Date
): RuntimeDiagnosticSnapshot => ({
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
  mcpHealth: mcpHealth(input.registry, input.manifest.activeTools),
  terminalCause: null,
  updatedAt: now().toISOString()
})

const replaceMutation = (
  snapshot: RuntimeDiagnosticSnapshot,
  mutation: RuntimeDiagnosticMutation
): RuntimeDiagnosticSnapshot => ({
  ...snapshot,
  mutations: [
    ...snapshot.mutations.filter(({ callId }) => callId !== mutation.callId),
    mutation
  ]
})

const recordToolStart = (
  snapshot: RuntimeDiagnosticSnapshot,
  event: Extract<StreamEvent, { readonly _tag: "ToolStart" }>,
  registry: ToolRegistry
): RuntimeDiagnosticSnapshot => {
  const risk = registry.riskFor(event.name)
  return risk === "mutate" || risk === "execute"
    ? replaceMutation(snapshot, {
        callId: event.id,
        toolId: event.name,
        targetCategory: event.target,
        status: "started",
        fileChangeSetIds: []
      })
    : snapshot
}

const recordToolEnd = (
  snapshot: RuntimeDiagnosticSnapshot,
  event: Extract<StreamEvent, { readonly _tag: "ToolEnd" }>
): RuntimeDiagnosticSnapshot => {
  const existing = snapshot.mutations.find(({ callId }) => callId === event.id)
  const withMutation = existing
    ? replaceMutation(snapshot, {
        ...existing,
        status: mutationStatus(event),
        fileChangeSetIds: event.fileChanges ? [event.fileChanges.id] : existing.fileChangeSetIds
      })
    : snapshot
  return event.fileChanges
    ? {
        ...withMutation,
        fileChangeStatuses: [...new Set([
          ...withMutation.fileChangeStatuses,
          ...event.fileChanges.changes.map(({ status }) => status)
        ])]
      }
    : withMutation
}

const recordEvent = (
  snapshot: RuntimeDiagnosticSnapshot,
  event: StreamEvent,
  registry: ToolRegistry
): RuntimeDiagnosticSnapshot => {
  switch (event._tag) {
    case "ToolStart":
      return recordToolStart(snapshot, event, registry)
    case "ToolEnd":
      return recordToolEnd(snapshot, event)
    case "RetryScheduled":
      return { ...snapshot, retries: Math.max(snapshot.retries, event.attempt) }
    case "Done":
      return { ...snapshot, terminalCause: "done" }
    case "Failed":
      return { ...snapshot, terminalCause: "failed" }
    default:
      return snapshot
  }
}

/** Reduce normalized events into metadata only; prompt, arguments, output, and patches never enter. */
export const makeRuntimeDiagnosticObserver = (input: ObserverInput): RuntimeDiagnosticObserver => {
  const now = input.now ?? (() => new Date())
  let current = initialSnapshot(input, now)

  return {
    initial: current,
    observe: (event) => {
      current = { ...recordEvent(current, event, input.registry), updatedAt: now().toISOString() }
      return current
    }
  }
}
