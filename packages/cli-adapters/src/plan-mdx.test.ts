import { describe, expect, it } from "vitest"
import { DEFAULT_PLAN_TEMPLATE } from "@jingler/core"
import { scriptedPlan } from "./adapter.js"
import { legacyPlanToMdx, parsePlanMdx } from "./plan-mdx.js"

describe("parsePlanMdx", () => {
  it("projects the default PRD template without evaluating MDX", () => {
    const result = parsePlanMdx(DEFAULT_PLAN_TEMPLATE)
    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.projection.title).toBe("PRD: [short outcome]")
    expect(result.projection.stages[0]?.acceptance[0]).toMatchObject({
      id: "01.1",
      status: "pending"
    })
  })

  it.each([
    ['import Widget from "./widget.js"', "executable-mdx"],
    ["<Widget />", "unknown-component"],
    ["# PRD\n\n<Stage id=\"01\" title=\"Build it\">No criteria</Stage>", "missing-acceptance"]
  ])("rejects unsafe or incomplete source: %s", (source, code) => {
    const result = parsePlanMdx(source)
    expect(result.valid).toBe(false)
    if (result.valid) return
    expect(result.diagnostics.map((item) => item.code)).toContain(code)
  })

  it("rejects duplicate stable ids", () => {
    const result = parsePlanMdx(`# PRD
<Stage id="01" title="Build">
<Acceptance id="01" status="pending">It works.</Acceptance>
</Stage>`)
    expect(result.valid).toBe(false)
    if (result.valid) return
    expect(result.diagnostics.some((item) => item.code === "duplicate-id")).toBe(true)
  })

  it("ignores JSX-looking code inside fenced samples", () => {
    const result = parsePlanMdx(`# PRD
<Stage id="01" title="Build">
\`\`\`tsx
const example = <Button>{label}</Button>
\`\`\`
<Acceptance id="01.1" status="pending">It works.</Acceptance>
</Stage>`)
    expect(result.valid).toBe(true)
  })

  it("does not project Stage or Acceptance examples from fenced code", () => {
    const result = parsePlanMdx(`# PRD
\`\`\`mdx
<Stage id="01" title="Example">
<Acceptance id="01.1" status="pending">Example only.</Acceptance>
</Stage>
\`\`\`
<Stage id="01" title="Real">
<Acceptance id="01.1" status="pending">Real criterion.</Acceptance>
</Stage>`)
    expect(result.valid).toBe(true)
    if (!result.valid) return
    expect(result.projection.stages.map((stage) => stage.title)).toStrictEqual(["Real"])
    expect(result.projection.stages[0]?.acceptance[0]?.text).toBe("Real criterion.")
  })

  it("allows braces in inline code but rejects multiline MDX expressions", () => {
    const inline = parsePlanMdx(`# PRD
<Stage id="01" title="Document syntax">
Use \`{ mode }\` in the example.
<Acceptance id="01.1" status="pending">It works.</Acceptance>
</Stage>`)
    expect(inline.valid).toBe(true)

    const multiline = parsePlanMdx(`# PRD
<Stage id="01" title="Execute">
{
  run()
}
<Acceptance id="01.1" status="pending">It works.</Acceptance>
</Stage>`)
    expect(multiline.valid).toBe(false)
    if (multiline.valid) return
    expect(multiline.diagnostics.map((item) => item.code)).toContain("executable-mdx")
  })

  it.each([
    "Rename a -> b",
    'Quote "this" & keep <that>',
    "import Widget from './widget.js'",
    "export const result = run()",
    "{executePlan()}"
  ])("always converts hostile legacy prose into valid data-only MDX: %s", (value) => {
    const base = scriptedPlan("legacy", 1)
    const first = base.steps[0]!
    const stageId = `stage-${value}`
    const source = legacyPlanToMdx({
      ...base,
      summary: value,
      raw: `${value}\n${value}`,
      steps: [
        {
          ...first,
          id: stageId,
          title: value,
          intent: value,
          approach: [value],
          files: [{ path: value, change: "M", added: 1, removed: 1 }],
          guards: [{ text: value, status: "open" }]
        }
      ],
      comments: [
        {
          id: `comment-${value}`,
          stepId: stageId,
          body: value,
          author: "user",
          createdAt: "2026-07-28T00:00:00.000Z",
          routed: false
        }
      ]
    })

    expect(parsePlanMdx(source)).toMatchObject({ valid: true })
  })
})
