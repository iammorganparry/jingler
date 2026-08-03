/**
 * Regenerate the distributable `jingler-team-memory` skill's tool catalog from the
 * server's live MCP tool definitions (the single source of truth). Add or change a
 * tool in src/mcp-memory.ts and re-run this so the skill never drifts.
 *
 *   pnpm --filter @jingler/server skill:memory          # rewrite tools.md
 *   pnpm --filter @jingler/server skill:memory:check    # CI: fail if stale
 *
 * Factual parts (names, one-line descriptions, privileges, argument names/types)
 * are generated. The "when to use" guidance is hand-authored per tool in
 * WHEN_TO_USE below; a NEW tool with no entry is emitted with a visible TODO so
 * `--check` fails until a human adds guidance.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { memoryMcpToolManifest } from "../src/mcp-memory.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOLS_MD = resolve(HERE, "../../../skills/jingler-team-memory/references/tools.md")

const PRIVILEGE_SECTIONS: ReadonlyArray<{ readonly privilege: string; readonly heading: string }> = [
  { privilege: "read", heading: "Retrieval (privilege: read)" },
  { privilege: "propose", heading: "Contribution (privilege: propose)" },
  { privilege: "review", heading: "Maintainer / review (privilege: review)" },
  { privilege: "schema", heading: "Schema (privilege: schema)" }
]

// Hand-authored "when to use" guidance, keyed by tool name. Purely additive to the
// generated facts; a tool missing here is flagged so guidance is never forgotten.
const WHEN_TO_USE: Record<string, string> = {
  memory_search: "Start here for almost every question or task. Follow up with memory_read on the top hits.",
  memory_read: "Load a page's full body before relying on it. Its revisionId is the baseRevisionId for updating that page via memory_propose.",
  memory_suggestions: "Broaden context around a topic after an initial search. Advisory hints, not graph edges.",
  memory_graph: "Get a structural overview of how memory connects, then drill in with memory_graph_neighborhood.",
  memory_graph_neighborhood: "See what one specific page links to / is linked from, without pulling the whole graph.",
  memory_edge_evidence: "Verify WHY two pages are linked before trusting the relationship.",
  memory_navigation: "Browse structurally (index pages, backlinks) rather than by search.",
  memory_dashboard: "Gauge vault size/health/activity, not to answer a specific question.",
  memory_export: "Only when the user explicitly wants a full dump/backup — this is a heavy call.",
  memory_propose: "Publish anything worth remembering (any domain). baseRevisionId is 'new' for a new page, or a memory_read revisionId to update one. Idempotent by identity+content.",
  memory_workflow_status: "After proposing, poll the returned handle to see whether it published or is awaiting review.",
  memory_reviews: "Only when the org enabled the human review gate — list proposals awaiting a maintainer.",
  memory_review: "Approve or reject a pending proposal (maintainer).",
  memory_schema_publish: "Advanced/maintainer path; most agents use memory_propose instead."
}

interface JsonSchemaNode {
  readonly type?: string
  readonly enum?: ReadonlyArray<unknown>
  readonly minimum?: number
  readonly maximum?: number
  readonly minLength?: number
  readonly $ref?: string
}
interface ObjectSchema {
  readonly properties?: Record<string, JsonSchemaNode>
  readonly required?: ReadonlyArray<string>
  readonly $defs?: Record<string, JsonSchemaNode>
}

const resolveNode = (node: JsonSchemaNode, defs: Record<string, JsonSchemaNode>): JsonSchemaNode => {
  if (typeof node.$ref === "string") {
    const key = node.$ref.replace("#/$defs/", "")
    return defs[key] ?? node
  }
  return node
}

const typeHint = (node: JsonSchemaNode, defs: Record<string, JsonSchemaNode>): string => {
  const resolved = resolveNode(node, defs)
  if (Array.isArray(resolved.enum)) return resolved.enum.map((value) => JSON.stringify(value)).join(" | ")
  const parts: Array<string> = [resolved.type ?? "value"]
  if (resolved.minimum !== undefined || resolved.maximum !== undefined) {
    parts.push(`${resolved.minimum ?? 1}–${resolved.maximum ?? "∞"}`)
  }
  if (resolved.minLength === 1 && resolved.type === "string") parts.push("non-empty")
  return parts.join(", ")
}

const renderArgs = (schema: ObjectSchema): string => {
  const properties = schema.properties ?? {}
  const names = Object.keys(properties)
  if (names.length === 0) return "- Args: none."
  const defs = schema.$defs ?? {}
  const required = new Set(schema.required ?? [])
  const rows = names.map((name) => {
    const flag = required.has(name) ? "required" : "optional"
    return `\`${name}\` (${flag}, ${typeHint(properties[name]!, defs)})`
  })
  return `- Args: ${rows.join("; ")}.`
}

const renderTool = (tool: (typeof memoryMcpToolManifest)[number]): string => {
  const guidance = WHEN_TO_USE[tool.name] ?? "TODO: add 'when to use' guidance for this tool."
  return [
    `### ${tool.name}`,
    tool.description,
    renderArgs(tool.inputSchema as ObjectSchema),
    `- When to use: ${guidance}`
  ].join("\n")
}

const render = (): string => {
  const sections = PRIVILEGE_SECTIONS.flatMap(({ privilege, heading }) => {
    const forPrivilege = memoryMcpToolManifest.filter((tool) => tool.privilege === privilege)
    if (forPrivilege.length === 0) return []
    return [`## ${heading}`, forPrivilege.map(renderTool).join("\n\n")]
  })
  return `${[
    "# Jingler Team Memory — tool catalog",
    "",
    "> GENERATED FILE — do not edit by hand. Regenerate with",
    "> `pnpm --filter @jingler/server skill:memory` after changing the MCP tools in",
    "> apps/server/src/mcp-memory.ts. The \"when to use\" lines are hand-authored in",
    "> apps/server/scripts/generate-memory-skill.ts.",
    "",
    "Every tool the memory MCP server exposes, its arguments, and when to reach for it.",
    "The server also returns these schemas at runtime (`tools/list`); this file is for",
    "*choosing* the right tool. Tools are gated by privilege — a read-only token can call",
    "the read tools but not the propose/review/schema tools.",
    "",
    sections.join("\n\n")
  ].join("\n")}\n`
}

const main = (): void => {
  const check = process.argv.includes("--check")
  const generated = render()
  if (check) {
    const current = readFileSync(TOOLS_MD, "utf8")
    if (current !== generated) {
      console.error(
        "✗ skills/jingler-team-memory/references/tools.md is out of date.\n" +
          "  Run: pnpm --filter @jingler/server skill:memory"
      )
      process.exit(1)
    }
    console.log("✓ jingler-team-memory tool catalog is up to date.")
    return
  }
  writeFileSync(TOOLS_MD, generated)
  console.log(`✓ Wrote ${TOOLS_MD} (${memoryMcpToolManifest.length} tools).`)
}

main()
