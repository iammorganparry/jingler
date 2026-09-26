import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { ManagedResourceId, type ManagedResource } from "@jingler/core"
import { Effect } from "effect"
import type { AgentResourceServiceShape } from "./agent-resource-service.js"
import { PONYTAIL_SKILLS_PATH, PONYTAIL_VERSION } from "./ponytail-resources.js"
import { ToolError } from "../tools/tool-registry.js"

export const BUILTIN_SKILLS = [
  {
    name: "/explain",
    description: "Publish a focused visual explanation of the current technical topic.",
    source: "skill" as const,
  },
  {
    name: "/ponytail",
    description: "Set Ponytail mode: lite, full, ultra, off, status, or default <mode>.",
    source: "command" as const,
  },
  {
    name: "/ponytail-review",
    description: "Review a diff exclusively for removable over-engineering.",
    source: "skill" as const,
  },
  {
    name: "/ponytail-audit",
    description: "Audit the repository for code and dependencies that can be removed.",
    source: "skill" as const,
  },
  {
    name: "/ponytail-debt",
    description: "List deliberate Ponytail shortcuts and their upgrade triggers.",
    source: "skill" as const,
  },
  {
    name: "/ponytail-gain",
    description: "Show Ponytail's published benchmark impact scoreboard.",
    source: "skill" as const,
  },
  {
    name: "/ponytail-help",
    description: "Show Ponytail levels, skills, commands, and deactivation help.",
    source: "skill" as const,
  },
]

export const isBuiltinResourceId = (id: string): boolean => BUILTIN_SKILLS.some(({ name }) => name === `/${id}`)

export type PortableResource = Pick<ManagedResource, "id" | "kind" | "name" | "description">

export const portableResourceCatalog = (resources: ReadonlyArray<ManagedResource>): ReadonlyArray<PortableResource> => [
  ...BUILTIN_SKILLS.map(({ name, description }) => ({
    id: ManagedResourceId.make(name.slice(1)), kind: "skill" as const, name: name.slice(1), description
  })),
  ...resources.filter(({ id }) => !BUILTIN_SKILLS.some(({ name }) => name === `/${id}`))
]

export const loadPortableResource = (
  service: AgentResourceServiceShape,
  available: ReadonlySet<string>,
  id: ManagedResourceId
) => {
  if (!available.has(id)) return Effect.fail(new ToolError("forbidden", `Managed resource "${id}" is unavailable for this target`))
  if (id === "explain") return Effect.succeed("Publish a focused visual explanation using jingler_publish_explanation. Choose concise prose, tables, code, or diagrams to explain the requested technical topic.")
  if (id === "ponytail-help") return Effect.succeed(`Ponytail in Jingler (bundled version ${PONYTAIL_VERSION})
Use /ponytail lite|full|ultra|off to set this chat's mode; /ponytail status shows it.
Use /ponytail default off|lite|full|ultra to set the default for new chats.
"stop ponytail" and "normal mode" turn it off in this chat.
Use /ponytail-review, /ponytail-audit, /ponytail-debt, or /ponytail-gain with optional task text.
The /skill:<id> spelling also works for skills. Commands are the same across Pi, Claude, Codex, and OpenCode.
Jingler owns these resources and persists modes per chat. Update Jingler to receive an updated pinned Ponytail package; native harness plugin update commands do not apply.`)
  const builtin = BUILTIN_SKILLS.some(({ name }) => name === `/${id}`)
  return (builtin ? Effect.succeed(join(PONYTAIL_SKILLS_PATH, id, "SKILL.md")) : service.reveal(id)).pipe(
    Effect.flatMap((path) => Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: () => new ToolError("execution-failed", "Could not load managed resource")
    })),
    Effect.mapError((cause) => cause instanceof ToolError ? cause : new ToolError("execution-failed", cause.message))
  )
}
