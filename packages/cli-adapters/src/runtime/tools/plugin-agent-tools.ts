import type { AgentRole, IssueReference, LoadedPlugin, RuntimeMode } from "@jingler/core"
import type { PluginHostRuntime } from "../../plugin-host.js"
import type {
  PluginAgentToolDescriptor,
  PluginAgentToolSessionContext
} from "../../plugin-host-protocol.js"
import { Schema } from "effect"
import type { PluginToolOrigin, ToolRegistry } from "./tool-registry.js"

const roles = ["conversation", "plan", "plan-execution", "review", "background"] as const satisfies ReadonlyArray<AgentRole>
const modes = ["ask", "accept-edits", "auto", "plan", "read-only"] as const satisfies ReadonlyArray<RuntimeMode>
const PluginToolInput = Schema.Record({ key: Schema.String, value: Schema.Unknown })

const issueReferenceOf = (value: unknown): IssueReference | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const issue = value as Record<string, unknown>
  if (
    typeof issue.providerId !== "string" || typeof issue.id !== "string" ||
    typeof issue.identifier !== "string" || typeof issue.url !== "string" ||
    typeof issue.title !== "string" || !Array.isArray(issue.labels)
  ) return null
  const labels = issue.labels.flatMap((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return []
    const label = candidate as Record<string, unknown>
    return typeof label.name === "string" && (typeof label.color === "string" || label.color === null)
      ? [{ name: label.name, color: label.color as string | null }]
      : []
  })
  if (labels.length !== issue.labels.length) return null
  return {
    providerId: issue.providerId,
    id: issue.id,
    ...(typeof issue.providerAccountId === "string"
      ? { providerAccountId: issue.providerAccountId }
      : {}),
    identifier: issue.identifier,
    url: issue.url,
    title: issue.title,
    labels
  }
}

const ISSUE_TOKEN_CHARACTER = /[a-z0-9-]/u
const isIssueTokenCharacter = (character: string | undefined): boolean =>
  character !== undefined && ISSUE_TOKEN_CHARACTER.test(character)

const hasBoundedReference = (text: string, candidate: string): boolean => {
  if (!candidate) return false
  let offset = text.indexOf(candidate)
  while (offset !== -1) {
    const before = text[offset - 1]
    const after = text[offset + candidate.length]
    if (!(isIssueTokenCharacter(before) || isIssueTokenCharacter(after))) return true
    offset = text.indexOf(candidate, offset + 1)
  }
  return false
}

const promptReferencesIssue = (prompt: string, issue: IssueReference): boolean => {
  const text = prompt.toLowerCase()
  return hasBoundedReference(text, issue.url.toLowerCase()) ||
    hasBoundedReference(text, issue.id.toLowerCase()) ||
    hasBoundedReference(text, issue.identifier.toLowerCase())
}

/** Decode the trusted Linear toolset's bounded issue-link envelope without parsing tool prose. */
export const issueReferencesFromPluginResult = (
  origin: PluginToolOrigin,
  value: unknown,
  userPrompt: string
): readonly IssueReference[] => {
  if (origin.pluginId !== "linear" || origin.toolsetId !== "linear.issues") return []
  if (typeof value !== "object" || value === null || Array.isArray(value)) return []
  const envelope = value as Record<string, unknown>
  if (envelope.kind !== "linear.issue-result" || !Array.isArray(envelope.issues)) return []
  if (envelope.linkIntent === "none") return []
  if (envelope.linkIntent !== "mutation" && envelope.linkIntent !== "user-reference") return []
  const issues = envelope.issues.map(issueReferenceOf)
  if (!issues.every((issue): issue is IssueReference =>
    issue !== null && issue.providerId === "linear"
  )) return []
  return envelope.linkIntent === "mutation"
    ? issues
    : issues.filter((issue) => promptReferencesIssue(userPrompt, issue))
}

/** Atomically hand every intentional trusted reference to persistence. */
export const persistPluginIssueReferences = async (
  origin: PluginToolOrigin,
  value: unknown,
  userPrompt: string,
  persist: (issues: readonly IssueReference[]) => Promise<void>
): Promise<boolean> => {
  const issues = issueReferencesFromPluginResult(origin, value, userPrompt)
  if (issues.length === 0) return false
  await persist(issues)
  return true
}

export interface PluginAgentToolsetSource {
  readonly plugin: LoadedPlugin
  readonly toolsetId: string
}

export interface PluginAgentToolRegistrationFailure {
  readonly pluginId: string
  readonly toolsetId: string
  readonly message: string
}

/** Enabled manifest toolsets, without importing any plugin host entry. */
export const enabledPluginAgentToolsets = (
  plugins: ReadonlyArray<LoadedPlugin>
): ReadonlyArray<PluginAgentToolsetSource> =>
  plugins.flatMap((plugin) =>
    !plugin.enabled || plugin.manifest.main === undefined
      ? []
      : (plugin.manifest.contributes?.agentToolsets ?? []).map((toolset) => ({
          plugin,
          toolsetId: toolset.id
        }))
  )

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const registerDescriptor = (
  registry: ToolRegistry,
  host: PluginHostRuntime,
  source: PluginAgentToolsetSource,
  descriptor: PluginAgentToolDescriptor,
  context: PluginAgentToolSessionContext
): void => {
  if (!registry.canRegister(descriptor.id)) {
    throw new Error(`agent tool id "${descriptor.id}" is already registered`)
  }
  registry.register({
    id: descriptor.id,
    version: "1",
    description: descriptor.description,
    origin: {
      kind: "plugin",
      pluginId: source.plugin.manifest.id,
      toolsetId: source.toolsetId
    },
    input: PluginToolInput,
    providerInputSchema: descriptor.inputSchema,
    risk: descriptor.risk,
    roles,
    modes,
    timeoutMs: descriptor.timeoutMs,
    outputBudget: descriptor.outputBudget,
    cancellable: descriptor.cancellable,
    idempotency: descriptor.idempotency,
    execute: (input, execution) =>
      host.invokeAgentTool(
        source.plugin,
        source.toolsetId,
        descriptor.id,
        input,
        context,
        execution.signal
      )
  })
}

/**
 * Materialize enabled plugin toolsets into one run-scoped registry.
 *
 * Failures are isolated per toolset: one broken third-party plugin must not
 * remove Jingler's own tools or another plugin's healthy toolset from the run.
 */
export const registerPluginAgentTools = async (
  registry: ToolRegistry,
  host: PluginHostRuntime,
  sources: ReadonlyArray<PluginAgentToolsetSource>,
  context: PluginAgentToolSessionContext
): Promise<ReadonlyArray<PluginAgentToolRegistrationFailure>> => {
  const failures: Array<PluginAgentToolRegistrationFailure> = []
  for (const source of sources) {
    try {
      const descriptors = await host.loadAgentToolset(source.plugin, source.toolsetId)
      const ids = new Set<string>()
      for (const descriptor of descriptors) {
        if (ids.has(descriptor.id) || !registry.canRegister(descriptor.id)) {
          throw new Error(`agent tool id "${descriptor.id}" is already registered`)
        }
        ids.add(descriptor.id)
      }
      for (const descriptor of descriptors) {
        registerDescriptor(registry, host, source, descriptor, context)
      }
    } catch (cause) {
      failures.push({
        pluginId: source.plugin.manifest.id,
        toolsetId: source.toolsetId,
        message: messageOf(cause)
      })
    }
  }
  return failures
}
