import { describe, expect, it } from "vitest"
import { parseOrchestratorAmendment, stripOrchestratorAmendment } from "./orchestrator-amend.js"

/**
 * The orchestrator amends its approved plan by re-issuing the whole plan as a
 * ` ````html ` block in an auto-mode reply. These cover the "is this an
 * amendment?" decision — a plan block with a stage is one; prose, or a block
 * with no stage, is not — and that the block is scrubbed from what the operator
 * reads.
 */

const planBlock = (body: string, legacy = false) =>
  `\`\`\`\`html${legacy ? " plan" : ""}\n${body}\n\`\`\`\``

const twoStages = planBlock(
  '<h1>PRD: x</h1><section data-stage="01" data-title="A"><div data-acceptance="01.1" data-status="pending">a</div></section>'
)

describe("parseOrchestratorAmendment", () => {
  it("returns the HTML when the reply carries a plan block with a stage", () => {
    const html = parseOrchestratorAmendment(`Folding that in.\n\n${twoStages}`)
    expect(html).not.toBeNull()
    expect(html).toContain('data-stage="01"')
  })

  it("continues to accept a legacy html plan amendment", () => {
    const html = parseOrchestratorAmendment(
      planBlock(
        '<h1>PRD: legacy</h1><section data-stage="01" data-title="A"><div data-acceptance="01.1" data-status="pending">a</div></section>',
        true
      )
    )
    expect(html).toContain("PRD: legacy")
  })

  it("returns null for an ordinary reply with no plan block", () => {
    expect(parseOrchestratorAmendment("The build passed. Anything else?")).toBeNull()
  })

  it("returns null for a plan block that declares no stage (an illustration)", () => {
    expect(parseOrchestratorAmendment(planBlock("<h1>PRD: x</h1><p>just prose</p>"))).toBeNull()
  })
})

describe("stripOrchestratorAmendment", () => {
  it("removes the plan block, leaving the human-readable reply", () => {
    const reply = stripOrchestratorAmendment(`Folding that in.\n\n${twoStages}`)
    expect(reply).toBe("Folding that in.")
    expect(reply).not.toContain("data-stage")
  })

  it("leaves a reply with no block untouched", () => {
    expect(stripOrchestratorAmendment("Done — PR opened.")).toBe("Done — PR opened.")
  })
})
