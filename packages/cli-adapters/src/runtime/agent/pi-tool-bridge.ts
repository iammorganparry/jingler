import { Type } from "@earendil-works/pi-ai"
import {
  defineTool,
  type ToolDefinition as PiToolDefinition
} from "@earendil-works/pi-coding-agent"
import type { AgentRunSpec } from "@jingler/core"
import { JSONSchema } from "effect"
import type {
  ToolRegistry
} from "../tools/tool-registry.js"
import type { AgentRuntimeContext } from "./agent-runtime.js"

import { executeRegistryTool } from "./registry-tool-bridge.js"

export interface PiToolBridgeOptions {
  readonly allowTool?: (toolId: string) => boolean
}

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
    return defineTool({
      name: capability.id,
      label: capability.id,
      description: capability.description,
      promptSnippet: capability.description,
      parameters: Type.Unsafe(providerInput ?? JSONSchema.make(input)),
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
