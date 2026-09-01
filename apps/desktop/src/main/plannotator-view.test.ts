import type { PlanDocument } from "@jingler/core"
import { describe, expect, it } from "vitest"
import { embeddedReviewHtmlOf, reviewMarkdownOf } from "./plannotator-view.js"

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
  it("disables the pinned first-run dialog and rejects an unknown bundle", () => {
    const marker = 'function P0n(){return Lt.getItem(Vot)==="true"?!1:Lt.getItem(R0n)!=="2"}'
    expect(embeddedReviewHtmlOf(`<html>${marker}</html>`))
      .toBe("<html>function P0n(){return!1}</html>")
    expect(() => embeddedReviewHtmlOf("<html></html>"))
      .toThrow("Pinned Plannotator onboarding marker is missing")
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
