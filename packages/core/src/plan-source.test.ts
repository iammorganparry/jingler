import { describe, expect, it } from "vitest"
import { parsePlanMdx } from "./plan-mdx.js"
import { appendPlanAnnotationSource, updatePlanSectionSource } from "./plan-source.js"

const doc = `# PRD: Demo

## Context

Original context prose.

## Goals

- First goal.

<Stage id="01" title="Build it">

### Intent

Because.

### Approach

1. Do the thing.

<Acceptance id="01.1" status="pending">
It works.
</Acceptance>

</Stage>

## Risks

- A risk.
`

const projectionOf = (source: string) => {
  const result = parsePlanMdx(source)
  if (!result.valid) throw new Error(`invalid: ${JSON.stringify(result.diagnostics)}`)
  return result.projection
}

describe("updatePlanSectionSource", () => {
  it("replaces one section body and leaves the rest byte-stable and valid", () => {
    const next = updatePlanSectionSource(doc, "Context", "Rewritten **context**.")
    expect(next).not.toBeNull()
    const projection = projectionOf(next!)
    const context = projection.sections.find((s) => s.title === "Context")
    expect(context?.markdown).toBe("Rewritten **context**.")
    // Siblings untouched.
    expect(projection.sections.find((s) => s.title === "Goals")?.markdown).toBe("- First goal.")
    expect(projection.sections.find((s) => s.title === "Risks")?.markdown).toBe("- A risk.")
    // The Stage and its acceptance survive verbatim.
    expect(projection.stages).toHaveLength(1)
    expect(projection.stages[0]?.acceptance[0]?.id).toBe("01.1")
  })

  it("edits the last section (bounded by end of source)", () => {
    const next = updatePlanSectionSource(doc, "Risks", "- A different risk.\n- And another.")
    const projection = projectionOf(next!)
    expect(projection.sections.find((s) => s.title === "Risks")?.markdown).toBe(
      "- A different risk.\n- And another."
    )
    expect(projection.stages).toHaveLength(1)
  })

  it("never emits executable MDX and stays parseable even with code fences", () => {
    const next = updatePlanSectionSource(
      doc,
      "Goals",
      "A goal with a diagram:\n\n```mermaid\ngraph TD; A-->B\n```"
    )
    const result = parsePlanMdx(next!)
    expect(result.valid).toBe(true)
    expect(result.diagnostics).toHaveLength(0)
  })

  it("does not match a heading that lives inside a stage or a code fence", () => {
    const tricky = `# PRD: Edge

## Context

Prose.

<Stage id="01" title="S">

### Intent

Body with a fenced heading:

\`\`\`md
## Context
fake
\`\`\`

<Acceptance id="01.1" status="pending">ok</Acceptance>

</Stage>
`
    const next = updatePlanSectionSource(tricky, "Context", "New real context.")
    const projection = projectionOf(next!)
    expect(projection.sections.find((s) => s.title === "Context")?.markdown).toBe(
      "New real context."
    )
    // The stage body (with its fenced "## Context") is preserved.
    expect(projection.stages[0]?.markdown).toContain("fake")
  })

  it("returns null for an unknown section", () => {
    expect(updatePlanSectionSource(doc, "Nonexistent", "x")).toBeNull()
  })
})

describe("appendPlanAnnotationSource with a text anchor", () => {
  it("serializes an anchored comment that parses back to the same anchor", () => {
    const next = appendPlanAnnotationSource(doc, {
      id: "cm1",
      stageId: "01",
      body: "Tighten this criterion.",
      author: "user",
      createdAt: "2026-07-28T00:00:00.000Z",
      anchor: { quote: "It works", prefix: '">\n', suffix: "\n</Acceptance" }
    })
    const result = parsePlanMdx(next)
    expect(result.valid).toBe(true)
    const annotation = result.projection?.annotations.find((a) => a.id === "cm1")
    expect(annotation?.anchor?.quote).toBe("It works")
    expect(annotation?.stageId).toBe("01")
  })

  it("escapes quotes/brackets in the anchor without breaking the tag", () => {
    const next = appendPlanAnnotationSource(doc, {
      id: "cm2",
      stageId: null,
      body: "note",
      author: "user",
      createdAt: "2026-07-28T00:00:00.000Z",
      anchor: { quote: 'a "quoted" <tag>', prefix: "", suffix: "" }
    })
    const result = parsePlanMdx(next)
    expect(result.valid).toBe(true)
    expect(result.projection?.annotations.find((a) => a.id === "cm2")?.anchor?.quote).toBe(
      'a "quoted" <tag>'
    )
  })
})
