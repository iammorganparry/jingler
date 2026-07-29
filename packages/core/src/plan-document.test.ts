import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { DEFAULT_PLAN_TEMPLATE_HTML } from "./plan-html.js"
import {
  PlanAcceptance,
  PlanDocument,
  PlanPrdStage,
  PlanTemplateConfig,
  planDocumentToPlan
} from "./plan-document.js"

describe("plan document schemas", () => {
  it("ships a PRD template with semantic stages and acceptance criteria", () => {
    expect(DEFAULT_PLAN_TEMPLATE_HTML).toContain("<h1>PRD:")
    expect(DEFAULT_PLAN_TEMPLATE_HTML).toContain("<section data-stage=")
    expect(DEFAULT_PLAN_TEMPLATE_HTML).toContain("data-acceptance=")
    expect(DEFAULT_PLAN_TEMPLATE_HTML).toContain("<h2>Testing</h2>")
    expect(DEFAULT_PLAN_TEMPLATE_HTML).toContain("<h2>Risks</h2>")
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

  it("decodes typed execution metadata while keeping legacy stages compatible", () => {
    const stage = {
      id: "02",
      title: "Execute workers",
      intent: "Run independent work concurrently.",
      markdown: "<p>Work.</p>",
      acceptance: [],
      dependencies: ["01"],
      complexity: "high",
      assignment: {
        agentId: "worker-a",
        cli: "codex",
        model: "gpt-5",
        reason: "The stage spans concurrency and persistence."
      },
      executionStatus: "running"
    }
    expect(Either.isRight(Schema.decodeUnknownEither(PlanPrdStage)(stage))).toBe(true)

    const legacy = {
      id: "01",
      title: "Legacy",
      intent: "Keep old projections readable.",
      markdown: "<p>Old.</p>",
      acceptance: []
    }
    expect(Either.isRight(Schema.decodeUnknownEither(PlanPrdStage)(legacy))).toBe(true)
  })

  it("keeps source and projection together at the RPC boundary", () => {
    const decoded = Schema.decodeUnknownEither(PlanDocument)({
      id: "p1",
      sessionId: "s1",
      producingChatId: "c1",
      revision: 1,
      status: "proposed",
      source: DEFAULT_PLAN_TEMPLATE_HTML,
      projection: { title: "PRD", sections: [], stages: [], annotations: [] },
      updatedAt: "2026-07-28T12:00:00.000Z",
      updatedBy: "agent"
    })
    expect(Either.isRight(decoded)).toBe(true)
    expect(
      Either.isRight(
        Schema.decodeUnknownEither(PlanTemplateConfig)({ source: DEFAULT_PLAN_TEMPLATE_HTML })
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
      source: DEFAULT_PLAN_TEMPLATE_HTML,
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
