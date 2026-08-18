import type { AgentRole, LoadedPlugin, RuntimeMode } from "@jingler/core"
import type { PluginHostRuntime } from "../../plugin-host.js"
import type {
  PluginAgentToolDescriptor,
  PluginAgentToolSessionContext
} from "../../plugin-host-protocol.js"
import { Schema } from "effect"
import type { ToolRegistry } from "./tool-registry.js"

const roles = ["conversation", "plan", "plan-execution", "review", "background"] as const satisfies ReadonlyArray<AgentRole>
const modes = ["ask", "accept-edits", "auto", "plan", "read-only"] as const satisfies ReadonlyArray<RuntimeMode>
const PluginToolInput = Schema.Record({ key: Schema.String, value: Schema.Unknown })

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
    throw new Error(`agent tool id \"${descriptor.id}\" is already registered`)
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
          throw new Error(`agent tool id \"${descriptor.id}\" is already registered`)
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
