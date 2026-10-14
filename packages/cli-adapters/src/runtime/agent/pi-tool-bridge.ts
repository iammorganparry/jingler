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

type JsonSchemaNode = { readonly type?: unknown; readonly anyOf?: ReadonlyArray<JsonSchemaNode>; readonly properties?: Record<string, JsonSchemaNode> }

const structuredTypes = (schema: JsonSchemaNode | undefined): ReadonlyArray<string> => {
  if (schema === undefined) return []
  const own = Array.isArray(schema.type) ? schema.type : [schema.type]
  return [...own, ...(schema.anyOf ?? []).flatMap(structuredTypes)].filter(
    (type): type is string => type === "array" || type === "object"
  )
}

/**
 * Models sometimes send an array or object argument as its JSON text
 * (`questions: "[{...}]"`). pi's validator coerces primitives but never parses
 * strings, so the call fails with "must be array". Parse top-level strings
 * whose schema wants structure; anything that doesn't parse to that shape is
 * left for the validator to reject as before.
 */
const parseStructured = (value: unknown, wanted: ReadonlyArray<string>): unknown => {
  if (typeof value !== "string" || wanted.length === 0) return value
  try {
    const parsed: unknown = JSON.parse(value)
    const kind = Array.isArray(parsed) ? "array" : typeof parsed === "object" && parsed !== null ? "object" : null
    return kind !== null && wanted.includes(kind) ? parsed : value
  } catch {
    // Not JSON: a genuine string the validator should judge.
    return value
  }
}

export const parseStringifiedArguments = (schema: JsonSchemaNode, args: unknown): unknown => {
  const properties = schema.properties
  if (typeof args !== "object" || args === null || Array.isArray(args) || properties === undefined) return args
  const entries = Object.entries(args).map(([key, value]) => [key, value, parseStructured(value, structuredTypes(properties[key]))] as const)
  if (entries.every(([, before, after]) => before === after)) return args
  return Object.fromEntries(entries.map(([key, , after]) => [key, after]))
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
