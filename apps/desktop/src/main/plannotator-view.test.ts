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
  it("keeps the chooser and seeds an app-wide saved layout before the bundle", () => {
    // biome-ignore lint/security/noSecrets: Static HTML fixture contains no credentials.
    const html = [
      "<html><head></head><body><script>",
      "let Wbe=TTt;",
      "</script>Choose how plans look</body></html>"
    ].join("")
    const embedded = embeddedReviewHtmlOf(html, {
      resolved: "true",
      gridEnabled: "false"
    })
    expect(embedded).toContain("Choose how plans look")
    expect(embedded).toContain("let Wbe=localStorage;")
    expect(embedded).toContain('"resolved":"true"')
    expect(embedded).toContain('"gridEnabled":"false"')
    expect(embedded.indexOf("<script>")).toBeLessThan(embedded.indexOf("</head>"))
    expect(PLANNOTATOR_PARTITION).toBe("persist:jingler-plannotator")
  })

  it("fails visibly when the pinned storage hook changes", () => {
    expect(() => embeddedReviewHtmlOf("<html><head></head></html>"))
      .toThrow("storage adapter marker is missing")
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
