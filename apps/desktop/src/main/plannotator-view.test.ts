import type { PlanDocument } from "@jingler/core"
import { describe, expect, it } from "vitest"
import {
  embeddedReviewHtmlOf,
  PLANNOTATOR_PARTITION,
  reviewMarkdownOf
} from "./plannotator-view.js"

const legacyDocument: PlanDocument = {
  id: "legacy-plan",
  sessionId: "session-1",
  producingChatId: "chat-1",
  revision: 1,
  status: "proposed",
  plan: {
    title: "Legacy plan",
    sections: [],
    annotations: [],
    stages: [
      {
        id: "step-1",
        title: "Implement auth",
        intent: "Implement auth",
        approach: [],
        tasks: [],
        files: [],
        diagrams: [],
        notes: [],
        acceptance: [{
          id: "step-1-done",
          text: "Implement auth",
          status: "pending",
          evidence: null
        }]
      },
      {
        id: "step-2",
        title: "Verify auth",
        intent: "Verify auth",
        approach: [],
        tasks: [],
        files: [],
        diagrams: [],
        notes: [],
        acceptance: [{
          id: "step-2-done",
          text: "Verify auth",
          status: "passed",
          evidence: null
        }]
      }
    ]
  },
  updatedAt: "2026-09-01T00:00:00.000Z",
  updatedBy: "agent"
}

describe("embeddedReviewHtmlOf", () => {
  it("keeps Plannotator's layout chooser and uses persistent app-wide storage", () => {
    const html = "<html>Choose how plans look</html>"
    expect(embeddedReviewHtmlOf(html)).toBe(html)
    expect(PLANNOTATOR_PARTITION).toBe("persist:jingler-plannotator")
  })
})

describe("reviewMarkdownOf", () => {
  it("preserves source markdown when available", () => {
    expect(reviewMarkdownOf({ ...legacyDocument, sourceMarkdown: "# Exact plan\n" }))
      .toBe("# Exact plan\n")
  })

  it("renders legacy checklist stages instead of reducing them to the title", () => {
    expect(reviewMarkdownOf(legacyDocument)).toContain("- [ ] Implement auth")
    expect(reviewMarkdownOf(legacyDocument)).toContain("- [x] Verify auth")
  })
})
