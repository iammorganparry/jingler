import { describe, expect, it } from "vitest"
import { DEFAULT_PLAN_TEMPLATE } from "@jingler/core"
import { parsePlanMdx } from "./plan-mdx.js"

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
})
