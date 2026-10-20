import { describe, expect, it } from "vitest"
import type { ExplanationPayload } from "./explanation-document.js"
import { explanationToMarkdown } from "./explanation-markdown.js"

const meta = { session: "s-1", project: "widget", branch: "feat/x", createdAt: "2026-10-13T00:00:00.000Z" }

const explanation: ExplanationPayload = {
  title: "How publishing works",
  summary: "One typed boundary.",
  sections: [
    {
      id: "flow",
      title: "Runtime flow",
      blocks: [
        { kind: "prose", id: "p", text: "Publishing is **atomic**." },
        { kind: "heading", id: "h", level: 3, text: "Steps" },
        { kind: "list", id: "l", ordered: true, items: ["write", "rename"] },
        { kind: "list", id: "l2", ordered: false, items: ["a"] },
        { kind: "code", id: "c", language: "ts", code: "const a = `x`\n```inner```" },
        { kind: "diagram", id: "d", source: "sequenceDiagram\n  A->>B: hi" },
        { kind: "table", id: "t", headers: ["Name", "Value"], rows: [["a|b", "1"]] }
      ]
    }
  ]
}

describe("explanationToMarkdown", () => {
  const markdown = explanationToMarkdown(explanation, meta)

  it("writes frontmatter, title, summary and section headings", () => {
    expect(markdown.startsWith(`---\nsession: "s-1"\nproject: "widget"\nbranch: "feat/x"\ncreatedAt: "2026-10-13T00:00:00.000Z"\n---\n\n# How publishing works\n\nOne typed boundary.\n\n## Runtime flow\n`)).toBe(true)
  })

  it("renders prose, headings and lists", () => {
    expect(markdown).toContain("Publishing is **atomic**.")
    expect(markdown).toContain("\n#### Steps\n")
    expect(markdown).toContain("1. write\n2. rename")
    expect(markdown).toContain("- a")
  })

  it("keeps code and Mermaid as fenced blocks, widening the fence around inner backticks", () => {
    expect(markdown).toContain("````ts\nconst a = `x`\n```inner```\n````")
    expect(markdown).toContain("```mermaid\nsequenceDiagram\n  A->>B: hi\n```")
  })

  it("renders tables as GFM with escaped pipes", () => {
    expect(markdown).toContain("| Name | Value |\n| --- | --- |\n| a\\|b | 1 |")
  })
})
