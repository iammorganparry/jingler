import { describe, expect, it } from "vitest"
import {
  appendPlanAnnotationHtml,
  DEFAULT_PLAN_TEMPLATE_HTML,
  parsePlanHtml,
  sanitizePlanHtml,
  updatePlanCriterionHtml
} from "./plan-html.js"

const DOC = `<h1>PRD: Ship it</h1>
<h2>Context</h2>
<p>One document is authoritative.</p>
<div data-diagram="mermaid"><pre>graph TD; A--&gt;B</pre></div>
<section data-stage="01" data-title="Persist the document">
<h3>Intent</h3>
<p>Keep every reader on one revision.</p>
<div data-acceptance="01.1" data-status="pending">The source survives restart.</div>
<aside data-annotation="a1" data-stage="01" data-author="user" data-status="open" data-quote="revision">Which revision?</aside>
</section>
<h2>Risks</h2>
<ul><li>A risk.</li></ul>`

describe("parsePlanHtml", () => {
  it("extracts title, sections, stages, acceptance, and annotations", () => {
    const result = parsePlanHtml(DOC)
    expect(result.valid).toBe(true)
    const p = result.projection!
    expect(p.title).toBe("PRD: Ship it")
    expect(p.sections.map((s) => s.title)).toEqual(["Context", "Risks"])
    expect(p.stages).toHaveLength(1)
    expect(p.stages[0]!.title).toBe("Persist the document")
    expect(p.stages[0]!.intent).toContain("one revision")
    expect(p.stages[0]!.acceptance[0]).toMatchObject({ id: "01.1", status: "pending" })
    expect(p.annotations[0]).toMatchObject({ id: "a1", stageId: "01" })
    expect(p.annotations[0]!.anchor?.quote).toBe("revision")
  })

  it("reports diagnostics for a doc with no title / no stage", () => {
    const result = parsePlanHtml("<p>just prose</p>")
    expect(result.valid).toBe(false)
    expect(result.diagnostics.map((d) => d.code)).toEqual(
      expect.arrayContaining(["missing-title", "missing-stage"])
    )
  })

  it("flags a stage with no acceptance and an invalid status", () => {
    const bad = `<h1>T</h1><section data-stage="01" data-title="x"><p>hi</p></section>`
    expect(parsePlanHtml(bad).diagnostics.some((d) => d.code === "missing-acceptance")).toBe(true)
    const badStatus = `<h1>T</h1><section data-stage="01" data-title="x"><div data-acceptance="1" data-status="nope">c</div></section>`
    expect(parsePlanHtml(badStatus).diagnostics.some((d) => d.code === "invalid-status")).toBe(true)
  })

  it("catches duplicate ids", () => {
    const dup = `<h1>T</h1><section data-stage="01" data-title="x"><div data-acceptance="01" data-status="pending">a</div></section><section data-stage="01" data-title="y"><div data-acceptance="z" data-status="pending">b</div></section>`
    expect(parsePlanHtml(dup).diagnostics.some((d) => d.code === "duplicate-id")).toBe(true)
  })

  it("validates the default template", () => {
    expect(parsePlanHtml(DEFAULT_PLAN_TEMPLATE_HTML).valid).toBe(true)
  })
})

describe("sanitizePlanHtml", () => {
  it("strips script/style/iframe subtrees entirely", () => {
    const out = sanitizePlanHtml('<h1>T</h1><script>alert(1)</script><style>x{}</style><iframe src="x"></iframe><p>ok</p>')
    expect(out).not.toMatch(/script|style|iframe|alert/)
    expect(out).toContain("<p>ok</p>")
  })

  it("drops event handlers, inline styles, and javascript: hrefs but keeps content", () => {
    const out = sanitizePlanHtml('<p onclick="evil()" style="color:red">hi <a href="javascript:evil()">x</a></p>')
    expect(out).not.toMatch(/onclick|style=|javascript:/)
    expect(out).toContain("hi")
    expect(out).toContain(">x<")
  })

  it("unwraps disallowed tags but keeps their text", () => {
    const out = sanitizePlanHtml("<h1>T</h1><marquee><p>keep me</p></marquee>")
    expect(out).not.toMatch(/marquee/)
    expect(out).toContain("keep me")
  })

  it("preserves plan data-attributes", () => {
    const out = sanitizePlanHtml('<section data-stage="01" data-title="x"><div data-acceptance="01.1" data-status="passed">c</div></section>')
    expect(out).toContain('data-stage="01"')
    expect(out).toContain('data-status="passed"')
  })
})

describe("html source rewriters", () => {
  it("sets acceptance status + evidence in place", () => {
    const next = updatePlanCriterionHtml(DOC, "01.1", "passed", "unit test green")!
    const crit = parsePlanHtml(next).projection!.stages[0]!.acceptance[0]!
    expect(crit.status).toBe("passed")
    expect(crit.evidence).toBe("unit test green")
    expect(updatePlanCriterionHtml(DOC, "nope", "passed", null)).toBeNull()
  })

  it("appends an anchored annotation into its stage that parses back", () => {
    const next = appendPlanAnnotationHtml(DOC, {
      id: "c2",
      stageId: "01",
      body: 'tighten <this> & "that"',
      author: "user",
      createdAt: "2026-07-28T00:00:00.000Z",
      anchor: { quote: "survives", prefix: "source ", suffix: " restart" }
    })
    const ann = parsePlanHtml(next).projection!.annotations.find((a) => a.id === "c2")!
    expect(ann.stageId).toBe("01")
    expect(ann.body).toBe('tighten <this> & "that"')
    expect(ann.anchor?.quote).toBe("survives")
  })
})
