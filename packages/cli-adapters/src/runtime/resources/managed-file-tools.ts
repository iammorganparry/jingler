import { readFile } from "node:fs/promises"
import { ManagedResourceId, type ManagedResource } from "@jingler/core"
import { Effect, Schema } from "effect"
import type { AgentResourceServiceShape } from "./agent-resource-service.js"
import { ToolError, type ToolRegistry } from "../tools/tool-registry.js"

const TOOL_OUTPUT_BYTES = 48 * 1024
const DESCRIPTION_BYTES = 160
const DEFAULT_LIST_LIMIT = 10
const roles = [
  "conversation",
  "plan",
  "plan-execution",
  "review",
  "context-digest",
  "background"
] as const
const modes = ["ask", "accept-edits", "auto", "plan", "read-only"] as const

const ListResourcesInput = Schema.Struct({
  query: Schema.optional(Schema.String.pipe(Schema.maxLength(200))),
  limit: Schema.optional(Schema.Int.pipe(Schema.between(1, 20)))
})
const LoadResourceInput = Schema.Struct({ id: ManagedResourceId })

const boundedInstructions = (content: string) => {
  const bytes = Buffer.from(content)
  return bytes.byteLength <= TOOL_OUTPUT_BYTES
    ? { instructions: content, truncated: false }
    : {
        instructions: bytes.subarray(0, TOOL_OUTPUT_BYTES).toString("utf8"),
        truncated: true
      }
}

const matches = (resource: ManagedResource, query: string): boolean => {
  const haystack = `${resource.id}\n${resource.name}\n${resource.description}`.toLowerCase()
  return haystack.includes(query.toLowerCase())
}

const listResources = (
  resources: ReadonlyArray<ManagedResource>,
  query: string | undefined,
  limit: number | undefined
) => {
  const filtered = query?.trim()
    ? resources.filter((resource) => matches(resource, query.trim()))
    : resources
  const bounded = filtered.slice(0, limit ?? DEFAULT_LIST_LIMIT)
  return {
    total: filtered.length,
    truncated: bounded.length < filtered.length,
    resources: bounded.map(({ id, kind, name, description }) => ({
      id,
      kind,
      name,
      description: description.slice(0, DESCRIPTION_BYTES)
    }))
  }
}

const loadResource = (
  service: AgentResourceServiceShape,
  availableIds: ReadonlySet<string>,
  id: ManagedResourceId
) => {
  if (!availableIds.has(id)) {
    return Effect.fail(
      new ToolError("forbidden", `Managed resource "${id}" is unavailable for this target`)
    )
  }
  return service.reveal(id).pipe(
    Effect.flatMap((path) =>
      Effect.tryPromise({
        try: () => readFile(path, "utf8"),
        catch: () => new ToolError("execution-failed", "Could not load managed resource")
      })
    ),
    Effect.map(boundedInstructions),
    Effect.mapError((cause) =>
      cause instanceof ToolError
        ? cause
        : new ToolError("execution-failed", cause.message)
    )
  )
}

/** Register a bounded catalog and loader; catalog size never expands the provider tool surface. */
export const registerManagedFileTools = (
  registry: ToolRegistry,
  service: AgentResourceServiceShape,
  resources: ReadonlyArray<ManagedResource>
): void => {
  const available = [...resources].sort((left, right) =>
    left.id.localeCompare(right.id)
  )
  const availableIds = new Set(available.map(({ id }) => id))
  registry.register({
    id: "jingler_list_resources",
    version: "2",
    description: "Search the enabled skill map before loading one skill or prompt.",
    input: ListResourcesInput,
    risk: "read",
    roles,
    modes,
    timeoutMs: 5_000,
    outputBudget: 64 * 1024,
    cancellable: true,
    idempotency: "safe",
    execute: ({ query, limit }) => Promise.resolve(listResources(available, query, limit))
  })
  registry.register({
    id: "jingler_load_resource",
    version: "2",
    description: "Load one enabled Jingler skill or prompt template by exact resource id.",
    input: LoadResourceInput,
    risk: "read",
    roles,
    modes,
    timeoutMs: 5_000,
    outputBudget: 64 * 1024,
    cancellable: true,
    idempotency: "safe",
    execute: ({ id }) => Effect.runPromise(loadResource(service, availableIds, id))
  })
}
