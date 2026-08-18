import type { AgentRole, IssueReference, LoadedPlugin, RuntimeMode } from "@jingler/core"
import { Option, Schema } from "effect"
import type {
  PluginAgentToolDescriptor,
  PluginAgentToolSessionContext,
  PluginHostPayload
} from "../../plugin-host-protocol.js"
import type { PluginToolOrigin, ToolRegistry } from "./tool-registry.js"

const roles = ["conversation", "plan", "plan-execution", "review", "background"] as const satisfies ReadonlyArray<AgentRole>
const modes = ["ask", "accept-edits", "auto", "plan", "read-only"] as const satisfies ReadonlyArray<RuntimeMode>
type PluginAgentToolInputValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | PluginAgentToolInput
  | ReadonlyArray<PluginAgentToolInputValue>

interface PluginAgentToolInput {
  readonly [key: string]: PluginAgentToolInputValue
}

const PluginAgentToolInputValue: Schema.Schema<PluginAgentToolInputValue> = Schema.suspend(() =>
  Schema.Union(
    Schema.String,
    Schema.Number,
    Schema.Boolean,
    Schema.Null,
    Schema.Undefined,
    Schema.Array(PluginAgentToolInputValue),
    Schema.Record({ key: Schema.String, value: PluginAgentToolInputValue })
  )
)
const PluginToolInput: Schema.Schema<PluginAgentToolInput> = Schema.Record({
  key: Schema.String,
  value: PluginAgentToolInputValue
})

const IssueReferenceResult = Schema.Struct({
  providerId: Schema.String,
  providerAccountId: Schema.optional(Schema.String),
  id: Schema.String,
  identifier: Schema.String,
  url: Schema.String,
  title: Schema.String,
  labels: Schema.Array(Schema.Struct({
    name: Schema.String,
    color: Schema.NullOr(Schema.String)
  }))
})
const LinearIssueResultEnvelope = Schema.Struct({
  kind: Schema.Literal("linear.issue-result"),
  issues: Schema.Array(IssueReferenceResult)
})

/** Decode the trusted Linear toolset's bounded issue-link envelope without parsing prose. */
export const issueReferencesFromPluginResult = <Value>(
  origin: PluginToolOrigin,
  value: Value
): readonly IssueReference[] => {
  if (origin.pluginId !== "linear" || origin.toolsetId !== "linear.issues") return []
  const decoded = Schema.decodeUnknownOption(LinearIssueResultEnvelope)(value)
  if (Option.isNone(decoded)) return []
  return decoded.value.issues.every((issue) => issue.providerId === "linear")
    ? decoded.value.issues
    : []
}

/** Atomically hand every trusted typed reference to persistence; returns whether links changed. */
export const persistPluginIssueReferences = async <Value>(
  origin: PluginToolOrigin,
  value: Value,
  persist: (issues: readonly IssueReference[]) => Promise<void>
): Promise<boolean> => {
  const issues = issueReferencesFromPluginResult(origin, value)
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

/** Minimal host capability needed to register and invoke plugin agent tools. */
export interface PluginAgentToolHost {
  readonly loadAgentToolset: (
    plugin: LoadedPlugin,
    toolsetId: string
  ) => Promise<ReadonlyArray<PluginAgentToolDescriptor>>
  readonly invokeAgentTool: (
    plugin: LoadedPlugin,
    toolsetId: string,
    toolId: string,
    input: PluginAgentToolInput,
    context: PluginAgentToolSessionContext,
    signal?: AbortSignal
  ) => Promise<PluginHostPayload>
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
  host: PluginAgentToolHost,
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
  host: PluginAgentToolHost,
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
