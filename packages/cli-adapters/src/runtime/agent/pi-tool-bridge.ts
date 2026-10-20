import { Type } from "@earendil-works/pi-ai"
import {
  defineTool,
  type ToolDefinition as PiToolDefinition
} from "@earendil-works/pi-coding-agent"
import type { AgentRunSpec } from "@jingler/core"
import { JSONSchema } from "effect"
import {
  normalizeStringifiedArguments,
  type JsonSchemaNode,
  type ToolRegistry
} from "../tools/tool-registry.js"
import type { AgentRuntimeContext } from "./agent-runtime.js"

import { executeRegistryTool } from "./registry-tool-bridge.js"

export interface PiToolBridgeOptions {
  readonly allowTool?: (toolId: string) => boolean
}

/**
 * pi validates tool arguments itself before Jingler's registry ever sees
 * them, so the shared stringified-argument fix in `tool-registry.ts` must
 * also run here or pi rejects the call first. Native Claude calls bypass pi
 * and reach the registry directly through the MCP relay, where that shared
 * fix is the only guard.
 */
export const parseStringifiedArguments = (schema: JsonSchemaNode, args: unknown): unknown =>
  normalizeStringifiedArguments(schema, args)

/** Adapt the exact active Jingler registry into pi custom tools. */
export const createPiTools = (
  registry: ToolRegistry,
  spec: Pick<AgentRunSpec, "role" | "mode">,
  context: AgentRuntimeContext,
  options: PiToolBridgeOptions = {}
): ReadonlyArray<PiToolDefinition> =>
  registry.capabilitiesFor(spec.role, spec.mode).map((capability) => {
    const input = registry.inputSchemaFor(capability.id)
    if (input === null) {
      throw new Error(`Active tool has no input schema: ${capability.id}`)
    }
    const providerInput = registry.providerInputSchemaFor(capability.id)
    const parameters = providerInput ?? JSONSchema.make(input)
    return defineTool({
      name: capability.id,
      label: capability.id,
      description: capability.description,
      promptSnippet: capability.description,
      parameters: Type.Unsafe(parameters),
      prepareArguments: (args) => parseStringifiedArguments(parameters as JsonSchemaNode, args) as never,
      execute: (toolCallId, parameters, signal, onUpdate) =>
        executeRegistryTool({
          registry,
          spec,
          context,
          id: capability.id,
          toolCallId,
          parameters,
          signal,
          allowed: options.allowTool?.(capability.id) ?? true,
          onUpdate
        })
    })
  })
