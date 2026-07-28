import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  DEFAULT_PLAN_TEMPLATE,
  PlanAcceptance,
  PlanDocument,
  PlanTemplateConfig,
  planDocumentToPlan
} from "./plan-document.js"

describe("plan document schemas", () => {
  it("ships a PRD template with semantic stages and acceptance criteria", () => {
    expect(DEFAULT_PLAN_TEMPLATE).toContain("# PRD:")
    expect(DEFAULT_PLAN_TEMPLATE).toContain("<Stage ")
    expect(DEFAULT_PLAN_TEMPLATE).toContain("<Acceptance ")
    expect(DEFAULT_PLAN_TEMPLATE).toContain("## Testing")
    expect(DEFAULT_PLAN_TEMPLATE).toContain("## Risks")
  })

  it("accepts evidence-bearing criteria", () => {
    const decoded = Schema.decodeUnknownEither(PlanAcceptance)({
      id: "01.1",
      text: "The saved plan survives restart.",
      status: "passed",
      evidence: "plan-store.test.ts"
    })
    expect(Either.isRight(decoded)).toBe(true)
  })

  it("rejects unknown acceptance states", () => {
    const decoded = Schema.decodeUnknownEither(PlanAcceptance)({
      id: "01.1",
      text: "No silent overwrite.",
      status: "maybe",
      evidence: null
    })
    expect(Either.isLeft(decoded)).toBe(true)
  })

  it("keeps source and projection together at the RPC boundary", () => {
    const decoded = Schema.decodeUnknownEither(PlanDocument)({
      id: "p1",
      sessionId: "s1",
      producingChatId: "c1",
      revision: 1,
      status: "proposed",
      source: DEFAULT_PLAN_TEMPLATE,
      projection: { title: "PRD", sections: [], stages: [], annotations: [] },
      updatedAt: "2026-07-28T12:00:00.000Z",
      updatedBy: "agent"
    })
    expect(Either.isRight(decoded)).toBe(true)
    expect(
      Either.isRight(
        Schema.decodeUnknownEither(PlanTemplateConfig)({ source: DEFAULT_PLAN_TEMPLATE })
      )
    ).toBe(true)
  })

  it("uses the PRD outcome as the compatibility-card summary", () => {
    const document = {
      id: "p1",
      sessionId: "s1",
      producingChatId: "c1",
      revision: 1,
      status: "proposed" as const,
      source: DEFAULT_PLAN_TEMPLATE,
      projection: {
        title: "PRD: Canonical interactive planning",
        sections: [],
        stages: [],
        annotations: []
      },
      updatedAt: "2026-07-28T12:00:00.000Z",
      updatedBy: "agent" as const
    }

    expect(planDocumentToPlan(document).summary).toBe("Canonical interactive planning")
  })
})
