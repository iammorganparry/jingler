import type { ExplanationPayload, VisualBlock } from "./explanation-document.js"

/** Frontmatter written at the top of an exported explanation note. */
export interface ExplanationNoteMeta {
  readonly session: string
  readonly project: string
  readonly branch: string
  readonly createdAt: string
}

const fence = (body: string, language = ""): string => {
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length))
  const ticks = "`".repeat(Math.max(3, longest + 1))
  return `${ticks}${language}\n${body}\n${ticks}`
}

const cell = (value: string): string => value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")

const row = (cells: ReadonlyArray<string>): string => `| ${cells.map(cell).join(" | ")} |`

const renderBlock = (block: VisualBlock): string => {
  switch (block.kind) {
    case "prose":
      return block.text
    case "heading":
      return `${"#".repeat(block.level + 1)} ${block.text}`
    case "list":
      return block.items.map((item, index) => `${block.ordered ? `${index + 1}.` : "-"} ${item}`).join("\n")
    case "code":
      return fence(block.code, block.language ?? "")
    case "diagram":
      return fence(block.source, "mermaid")
    case "change":
      return `\`${block.path}\`\n\n${fence(block.patch, "diff")}`
    case "table":
      return [row(block.headers), row(block.headers.map(() => "---")), ...block.rows.map(row)].join("\n")
    case "architecture": {
      const label = (id: string) => block.components.find((component) => component.id === id)?.label ?? id
      return [
        ...(block.title === undefined ? [] : [`**${block.title}**`, ""]),
        ...block.layers.flatMap((layer) => [
          `- ${layer.label}`,
          ...block.components
            .filter((component) => component.layer === layer.id)
            .map((component) => `  - ${component.label} (${component.shape})${component.detail ? `: ${component.detail}` : ""}`)
        ]),
        ...block.links.map((link) => `- ${label(link.from)} → ${label(link.to)}${link.label ? `: ${link.label}` : ""}`)
      ].join("\n")
    }
  }
}

/** Render an explanation as an Obsidian-ready Markdown note with YAML frontmatter. */
export const explanationToMarkdown = (
  explanation: ExplanationPayload,
  meta: ExplanationNoteMeta
): string => {
  const frontmatter = Object.entries(meta).map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
  const sections = explanation.sections.map((section) =>
    [`## ${section.title}`, ...section.blocks.map(renderBlock)].join("\n\n")
  )
  return [`---\n${frontmatter.join("\n")}\n---`, `# ${explanation.title}`, explanation.summary, ...sections]
    .filter((part) => part.length > 0)
    .join("\n\n") + "\n"
}
