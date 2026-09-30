import type { AgentRunSpec } from "@jingler/core"
import { Effect, type Scope } from "effect"
import { ponytailPromptLayers } from "../resources/ponytail-resources.js"
import { PromptCompiler } from "../prompt/prompt-compiler.js"
import {
  DELEGATION_DEFAULT_PROMPT_LAYER,
  runtimeInvariantLayers
} from "../prompt/role-profiles.js"
import { startRegistryMcpRelay } from "../providers/registry-mcp-relay.js"
import type { ToolRegistry } from "../tools/tool-registry.js"
import {
  AgentRuntimeError,
  type AgentRuntimeContext,
  type AgentRuntimeShape
} from "./agent-runtime.js"
import { createJinglerTools } from "./pi-jingler-tools.js"

export type NativeSubagentFleetHandlers = Pick<
  AgentRuntimeShape,
  "controlSubagent" | "subagentFleetSnapshot" | "subagentTranscript"
>

export interface NativeRuntimeToolsOptions {
  readonly createToolRegistry?: (spec: AgentRunSpec, context: AgentRuntimeContext) => Effect.Effect<ToolRegistry, AgentRuntimeError, Scope.Scope>
  readonly subagentFleet?: NativeSubagentFleetHandlers
}

const failure = (cause: unknown) => new AgentRuntimeError({
  reason: "runtime",
  message: cause instanceof Error ? cause.message : "Could not prepare Jingler tools",
  cause
})

/** One run owns the registry, credentials, prompt and relay lifetime. */
export const prepareNativeRuntimeTools = (
  spec: AgentRunSpec,
  context: AgentRuntimeContext,
  options: NativeRuntimeToolsOptions
) => Effect.gen(function* () {
  const registry = yield* (options.createToolRegistry?.(spec, context) ??
    createJinglerTools({ context, cwd: spec.cwd, mcp: context.mcp }).pipe(Effect.mapError(failure)))
  const systemPrompt = yield* Effect.try({
    try: () => new PromptCompiler().compile({
      layers: [
        ...runtimeInvariantLayers(spec.role, spec.mode),
        ...ponytailPromptLayers(spec.ponytailMode),
        {
          id: "runtime.tool-transport", kind: "tools", trust: "trusted", required: true, version: "1",
          content: `The active catalog uses canonical Jingler tool IDs. Their callable names in this harness are ${spec.runtimeId === "opencode" ? "jingler_" : "mcp__jingler__"}<tool ID>. These names refer to the same tools, not extra capabilities. Use those callable names. If the harness defers MCP tools, use its native tool discovery to load the matching Jingler tool before calling it.`
        },
        ...(registry.capabilitiesFor(spec.role, spec.mode).some(({ id }) => id === "subagent")
          ? [DELEGATION_DEFAULT_PROMPT_LAYER]
          : [])
      ],
      tools: registry.capabilitiesFor(spec.role, spec.mode),
      tokenBudget: 8_000
    }).text,
    catch: failure
  })
  const relay = yield* Effect.acquireRelease(
    Effect.tryPromise({ try: () => startRegistryMcpRelay({ registry, spec, context }), catch: failure }),
    (owned) => Effect.promise(owned.close)
  )
  return { registry, systemPrompt, relay }
})
