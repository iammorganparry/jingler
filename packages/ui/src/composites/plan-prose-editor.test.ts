// @vitest-environment jsdom
import { Editor } from "@tiptap/core"
import { afterEach, describe, expect, it } from "vitest"
import { getEditorMarkdown, planProseExtensions } from "./plan-prose-editor.js"

let editor: Editor | null = null

const roundTrip = (markdown: string): string => {
  editor = new Editor({ extensions: planProseExtensions(), content: markdown })
  return getEditorMarkdown(editor)
}

afterEach(() => {
  editor?.destroy()
  editor = null
})

// Normalize away purely cosmetic differences the serializer may introduce
// (bullet glyph, trailing whitespace). Acceptance 02.2 is "stable modulo
// formatting", so we assert semantic stability, not byte identity.
const norm = (md: string): string =>
  md
    .replace(/^[*+] /gm, "- ")
    // Canonicalize single-emphasis glyph (*italic* vs _italic_); leave **bold**.
    .replace(/(?<!\*)\*(?!\*)([^*\n]+)\*(?!\*)/g, "_$1_")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

describe("plan prose markdown round-trip", () => {
  it("preserves headings, emphasis, lists, and inline code", () => {
    const md = [
      "### Intent",
      "",
      "This is **bold**, _italic_, and `code`.",
      "",
      "- one",
      "- two",
      "",
      "1. first",
      "2. second"
    ].join("\n")
    expect(norm(roundTrip(md))).toBe(norm(md))
  })

  it("preserves a mermaid code fence verbatim", () => {
    const md = ["Diagram:", "", "```mermaid", "graph TD; A-->B", "```"].join("\n")
    const out = roundTrip(md)
    expect(out).toContain("```mermaid")
    expect(out).toContain("graph TD; A-->B")
  })

  it("never emits raw HTML/JSX (html:false)", () => {
    const out = roundTrip("A paragraph.\n\n<Stage id=\"x\" title=\"y\">nope</Stage>")
    // The JSX is neutralized to text/escaped, never re-emitted as a live tag.
    expect(out).not.toMatch(/<Stage\b/)
  })

  it("is idempotent on a second pass", () => {
    const md = "# Title\n\nSome **prose** with a [link](https://example.com)."
    const once = roundTrip(md)
    const twice = roundTrip(once)
    expect(norm(twice)).toBe(norm(once))
  })
})
