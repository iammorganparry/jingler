import { describe, expect, it } from "vitest"
import { validatePlanMarkdown } from "./plan-validation.ts"

const validStage = `## Ship auth <!-- id: ship-auth -->
Users can sign in.

### Approach
- Reuse the session store.

- [ ] Implement sign-in

### Technical explanation
The existing route will call the shared store.

### Acceptance
- [ ] Sign-in succeeds (test: src/auth.test.ts::signs in)

### Files
- \`src/auth.ts\` — M

> complexity: low
`

describe("validatePlanMarkdown", () => {
  it("accepts complete explicit stages and legacy plans", () => {
    expect(validatePlanMarkdown(validStage)).toEqual([])
    expect(validatePlanMarkdown("## Legacy stage\n- [ ] Do it\n")).toEqual([])
  })

  it("reports missing stage fields and malformed dependencies", () => {
    const errors = validatePlanMarkdown(`## Empty <!-- id: same -->\n\n## Again <!-- id: same -->\n> depends: missing, same\n`)
    expect(errors).toContain('Stage "Again" duplicates id "same".')
    expect(errors).toContain('Stage "Again" depends on unknown id "missing".')
    expect(errors).toContain("Stage dependencies contain a cycle.")
    expect(errors.some((error) => error.includes("Technical explanation"))).toBe(true)
    expect(errors.some((error) => error.includes("test path and named case"))).toBe(false)
  })
})
