import { describe, expect, it } from "vitest"
import { findingsToDrafts } from "./findings-to-drafts.js"

const base = { endLine: null, title: "T.", rationale: "R.", suggestion: null, resolvedBy: null }

describe("findingsToDrafts", () => {
  it("maps severity and drops findings without a line anchor", () => {
    const drafts = findingsToDrafts({
      findings: [
        { ...base, id: "a", path: "src/a.ts", line: 3, severity: "critical" },
        { ...base, id: "b", path: "src/b.ts", line: 9, severity: "nit", suggestion: "Rename." },
        { ...base, id: "c", path: null, line: null, severity: "major" }
      ]
    })
    expect(drafts).toEqual([
      { id: "a", severity: "issue", path: "src/a.ts", line: 3, body: "T. R." },
      { id: "b", severity: "nit", path: "src/b.ts", line: 9, body: "T. R. Suggestion: Rename." }
    ])
  })
})
