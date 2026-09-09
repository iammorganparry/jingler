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

  it("renders available technical stage detail when source markdown is absent", () => {
    const document: PlanDocument = {
      ...legacyDocument,
      plan: {
        ...legacyDocument.plan,
        sections: [{
          id: "context",
          title: "Context",
          blocks: [{ kind: "prose", id: "why", text: "Why this matters." }]
        }],
        stages: [{
          id: "ship-auth",
          title: "Ship auth",
          intent: "Users can sign in.",
          approach: ["Reuse the session store"],
          tasks: [{ id: "task-1", text: "Implement sign-in", status: "pending" }],
          files: [{ path: "src/auth.ts", change: "M" }],
          diagrams: [{ id: "flow", source: "graph TD; A-->B" }],
          notes: [{ kind: "prose", id: "note", text: "The route calls the shared store." }],
          acceptance: [{
            id: "accept-1",
            text: "Sign-in succeeds",
            testReferences: [{ path: "src/auth.test.ts", cases: ["signs in"] }],
            status: "pending",
            evidence: null
          }],
          dependencies: ["database"],
          complexity: "medium"
        }],
        annotations: []
      }
    }
    const markdown = reviewMarkdownOf(document)
    expect(markdown).toContain("## Context\n\nWhy this matters.")
    expect(markdown).toContain("## Ship auth <!-- id: ship-auth -->")
    expect(markdown).toContain("### Technical explanation\nThe route calls the shared store.")
    expect(markdown).toContain("(test: src/auth.test.ts::signs in)")
    expect(markdown).toContain("- `src/auth.ts` — M")
    expect(markdown).toContain("```mermaid\ngraph TD; A-->B\n```")
    expect(markdown).toContain("> depends: database")
  })
})
