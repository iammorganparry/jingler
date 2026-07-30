// @vitest-environment jsdom
import { parsePlanHtml, planStageSemanticFingerprint } from "@jingler/core"
import { Editor } from "@tiptap/core"
import { afterEach, describe, expect, it } from "vitest"
import {
  applyPlanComment,
  removePlanComment,
  resolvePlanCommentRange
} from "./plan-doc-comment.js"
import { planDocExtensions } from "./plan-doc-extensions.js"

// The `/` suggestion plugin is React/floating-ui popup chrome with no schema of
// its own; the headless round-trip exercises the schema, so build without it.
const extensions = () => planDocExtensions({ slash: false })

/**
 * Proves the Tiptap schema round-trips the HTML plan dialect: what the editor
 * emits (`getHTML()`) must re-parse, through the authoritative `@jingler/core`
 * engine, to the SAME PlanPrd projection as the source. A divergence here means
 * the live editor silently corrupts a plan's structure on the first edit.
 */

const FIXTURE = `<h1>PRD: Ship the plan doc editor</h1>
<h2>Context</h2>
<p>Plans are now HTML documents edited in a Notion-like Tiptap editor.</p>
<h2>Goals</h2>
<ul><li>Round-trip the structural markup losslessly.</li></ul>
<section data-stage="01" data-title="Build the Tiptap nodes" data-depends-on="" data-complexity="high">
<h3>Intent</h3>
<p>Author the four custom nodes.</p>
<div data-assignment data-agent-id="worker-ui" data-cli="codex" data-model="gpt-5.6-terra" data-reason="Complex editor schema work." data-status="running"></div>
<ul data-files><li data-change="M" data-added="12" data-removed="3">src/plan-doc.ts</li></ul>
<div data-acceptance="01.1" data-status="passed" data-evidence="round-trip test is green">Nodes round-trip the data-attribute format.</div>
<div data-acceptance="01.2" data-status="pending">The insert toolbar adds every widget.</div>
<aside data-annotation="a1" data-stage="01" data-author="user" data-status="open" data-created-at="2026-07-29T10:00:00.000Z">Cycle the status pill on click.</aside>
</section>
<h2>Flow</h2>
<div data-diagram="mermaid"><pre>graph TD; Edit--&gt;Serialize--&gt;Validate</pre></div>`

let editor: Editor | null = null

const roundTripHtml = (html: string): string => {
  editor = new Editor({ extensions: extensions(), content: html })
  return editor.getHTML()
}

/** PM range [from, to) of the first `needle` occurrence in a text node. */
const rangeOf = (ed: Editor, needle: string): { from: number; to: number } => {
  let found: { from: number; to: number } | null = null
  ed.state.doc.descendants((node, pos) => {
    if (found || !node.isText || !node.text) return
    const idx = node.text.indexOf(needle)
    if (idx >= 0) found = { from: pos + idx, to: pos + idx + needle.length }
  })
  if (!found) throw new Error(`"${needle}" not found in doc`)
  return found
}

afterEach(() => {
  editor?.destroy()
  editor = null
})

describe("plan doc HTML round-trip", () => {
  it("re-parses to a valid plan with the same projection", () => {
    const html = roundTripHtml(FIXTURE)
    const result = parsePlanHtml(html)

    expect(result.diagnostics).toEqual([])
    expect(result.valid).toBe(true)
    if (!result.valid) return // narrows for the assertions below

    const { projection } = result
    expect(projection.title).toBe("PRD: Ship the plan doc editor")

    // Stage id + title survive on the <section> data-attributes.
    expect(projection.stages).toHaveLength(1)
    const stage = projection.stages[0]!
    expect(stage.id).toBe("01")
    expect(stage.title).toBe("Build the Tiptap nodes")
    expect(stage).toMatchObject({
      dependencies: [],
      complexity: "high",
      assignment: {
        agentId: "worker-ui",
        cli: "codex",
        model: "gpt-5.6-terra",
        reason: "Complex editor schema work."
      },
      executionStatus: "running"
    })
    expect(html).toContain('data-assignment=""')
    expect(html).toContain('data-agent-id="worker-ui"')
    expect(html).toContain('data-cli="codex"')
    expect(html).toContain('data-model="gpt-5.6-terra"')
    expect(html).toContain('data-files=""')
    expect(html).toContain('data-change="M"')
    expect(html).toContain('data-added="12"')
    expect(html).toContain('data-removed="3"')

    // Acceptance ids + statuses survive on the <div data-acceptance>.
    expect(stage.acceptance.map((a) => a.id)).toEqual(["01.1", "01.2"])
    expect(stage.acceptance.map((a) => a.status)).toEqual(["passed", "pending"])
    expect(stage.acceptance[0]!.evidence).toBe("round-trip test is green")

    // Annotation id survives on the <aside data-annotation>.
    expect(projection.annotations.map((a) => a.id)).toContain("a1")

    // The mermaid diagram survives as a <div data-diagram="mermaid">.
    expect(html).toContain('data-diagram="mermaid"')
    expect(html).toContain("graph TD; Edit")
  })

  it("is idempotent on a second serialize pass", () => {
    const once = roundTripHtml(FIXTURE)
    const twice = roundTripHtml(once)
    const a = parsePlanHtml(once)
    const b = parsePlanHtml(twice)
    expect(a.valid).toBe(true)
    expect(b.valid).toBe(true)
    expect(b.html).toBe(a.html)
  })

  it("preserves the semantic fingerprint used by in-flight workers", () => {
    const before = parsePlanHtml(FIXTURE)
    const after = parsePlanHtml(roundTripHtml(FIXTURE))
    expect(before.valid).toBe(true)
    expect(after.valid).toBe(true)
    if (!before.valid || !after.valid) return

    expect(planStageSemanticFingerprint(after.projection.stages[0]!)).toBe(
      planStageSemanticFingerprint(before.projection.stages[0]!)
    )
  })

  it("commenting a selection round-trips to an <aside data-annotation> with the quote", () => {
    const COMMENTABLE = `<h1>PRD: Comment round-trip</h1>
<section data-stage="01" data-title="Only stage">
<h3>Intent</h3>
<p>The quick brown fox jumps.</p>
<div data-acceptance="01.1" data-status="pending">A criterion.</div>
</section>`
    editor = new Editor({ extensions: extensions(), content: COMMENTABLE })

    const { from, to } = rangeOf(editor, "quick")
    const id = applyPlanComment(editor, { from, to, body: "Needs detail." })

    const html = editor.getHTML()
    // The comment serializes to the <aside> shape the HTML engine round-trips…
    expect(html).toContain('data-annotation="a1"')
    expect(html).toContain('data-quote="quick"')
    expect(html).toContain('data-author="user"')
    expect(html).toContain('data-status="open"')
    // The visible highlight is derived chrome, not a second persisted source of
    // truth. It is present in the editor DOM but absent from serialized HTML.
    expect(html).not.toContain("<mark>")
    expect(
      editor.view.dom.querySelector('[data-plan-comment-highlight="a1"]')?.textContent
    ).toBe("quick")

    const result = parsePlanHtml(html)
    expect(result.diagnostics).toEqual([])
    expect(result.valid).toBe(true)
    if (!result.valid) return

    const annotation = result.projection.annotations.find((a) => a.id === id)
    expect(annotation).toBeDefined()
    expect(annotation?.body).toBe("Needs detail.")
    expect(annotation?.author).toBe("user")
    expect(annotation?.status).toBe("open")
    expect(annotation?.anchor?.quote).toBe("quick")
  })

  it("re-resolves a comment after surrounding edits and removes only that annotation", () => {
    const COMMENTABLE = `<h1>PRD: Comment lifecycle</h1>
<section data-stage="01" data-title="Only stage">
<p>The quick brown fox jumps.</p>
<div data-acceptance="01.1" data-status="pending">A criterion.</div>
</section>`
    editor = new Editor({ extensions: extensions(), content: COMMENTABLE })
    const first = rangeOf(editor, "quick")
    const firstId = applyPlanComment(editor, { ...first, body: "First." })
    const second = rangeOf(editor, "brown")
    const secondId = applyPlanComment(editor, { ...second, body: "Second." })

    editor.commands.insertContentAt(first.from, "very ")
    const resolved = resolvePlanCommentRange(editor.state.doc, {
      quote: "quick",
      prefix: "The ",
      suffix: " brown"
    })
    expect(resolved).toEqual({
      from: first.from + "very ".length,
      to: first.to + "very ".length
    })

    expect(removePlanComment(editor, firstId)).toBe(true)
    expect(editor.getHTML()).not.toContain(`data-annotation="${firstId}"`)
    expect(editor.getHTML()).toContain(`data-annotation="${secondId}"`)
    expect(
      editor.view.dom.querySelector(`[data-plan-comment-highlight="${firstId}"]`)
    ).toBeNull()
    expect(
      editor.view.dom.querySelector(`[data-plan-comment-highlight="${secondId}"]`)?.textContent
    ).toBe("brown")
  })
})
