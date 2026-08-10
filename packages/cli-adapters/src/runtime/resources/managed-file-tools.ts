import { readFile } from "node:fs/promises"
import type { ManagedResource } from "@jingler/core"
import { Effect, Schema } from "effect"
import type { AgentResourceServiceShape } from "./agent-resource-service.js"
import { ToolError, type ToolRegistry } from "../tools/tool-registry.js"

const TOOL_OUTPUT_BYTES = 48 * 1024
const roles = [
  "conversation",
  "plan",
  "plan-execution",
  "review",
  "context-digest",
  "background"
] as const
const modes = ["ask", "accept-edits", "auto", "plan", "read-only"] as const

const boundedInstructions = (content: string) => {
  const bytes = Buffer.from(content)
  return bytes.byteLength <= TOOL_OUTPUT_BYTES
    ? { instructions: content, truncated: false }
    : {
        instructions: bytes.subarray(0, TOOL_OUTPUT_BYTES).toString("utf8"),
        truncated: true
      }
}

/** Register lightweight descriptors; file bodies are read only after invocation. */
export const registerManagedFileTools = (
  registry: ToolRegistry,
  service: AgentResourceServiceShape,
  resources: ReadonlyArray<ManagedResource>
): void => {
  for (const resource of resources) {
    if (resource.kind === "mcp") continue
    registry.register({
      id: `resource__${resource.id}`,
      version: "1",
      description: `${resource.kind === "skill" ? "Load skill" : "Load prompt template"}: ${resource.description}`,
      input: Schema.Struct({}),
      risk: "read",
      roles,
      modes,
      timeoutMs: 5_000,
      outputBudget: 64 * 1024,
      cancellable: true,
      idempotency: "safe",
      execute: () => Effect.runPromise(
        service.reveal(resource.id).pipe(
          Effect.flatMap((path) => Effect.tryPromise({
            try: () => readFile(path, "utf8"),
            catch: () => new ToolError(
              "execution-failed",
              `Could not load managed ${resource.kind}`
            )
          })),
          Effect.map(boundedInstructions),
          Effect.mapError((cause) =>
            cause instanceof ToolError
              ? cause
              : new ToolError("execution-failed", cause.message)
          )
        )
      )
    })
  }
}
