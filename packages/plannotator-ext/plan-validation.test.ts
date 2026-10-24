import { describe, expect, it } from "vitest"
import { validatePlanMarkdown } from "./plan-validation.ts"

const validStage = `## Proposed flow
\`\`\`mermaid
flowchart LR
  input --> auth
\`\`\`

## Ship auth <!-- id: ship-auth -->

### Deliverable
Users can sign in.

### User story
**As a** returning user
**I want** to sign in with my existing session
**So that** I can continue my work

### Approach
- Reuse the session store.

- [ ] Implement sign-in

### Technical explanation
The existing route will call the shared store.

### Acceptance
- [ ] Sign-in succeeds (test: src/auth.test.ts::signs in)

### Definition of Done
- Acceptance criteria verified
- Focused tests and typecheck pass

### Files
- \`src/auth.ts\` — M

> complexity: low

## Test strategy
Unit tests cover sign-in.
`

describe("validatePlanMarkdown", () => {
  it("accepts complete explicit stages", () => {
    expect(validatePlanMarkdown(validStage)).toEqual([])
  })

  it("rejects flat checklists and stages without ids, telling the agent the stage shape", () => {
    for (const flat of ["# Work\n- [ ] Do it\n", "## Legacy stage\n- [ ] Do it\n"]) {
      const errors = validatePlanMarkdown(flat)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain("<!-- id: stable-id -->")
      expect(errors[0]).toContain("Technical explanation")
    }
  })

  it("rejects a staged plan missing Technical explanation or Deliverable", () => {
    expect(validatePlanMarkdown(validStage.replace(/### Technical explanation\n.*\n/, ""))).toContain(
      'Stage "Ship auth" needs a Technical explanation.'
    )
    expect(validatePlanMarkdown(validStage.replace(/### Deliverable\n.*\n/, ""))).toContain(
      'Stage "Ship auth" needs a Deliverable.'
    )
  })

  it("rejects a pathless diff fence", () => {
    for (const fence of ["```diff", "  ```diff"]) {
      const plan = validStage.replace("### Files", `${fence}\n@@ -1 +1 @@\n-old\n+new\n  \`\`\`\n\n### Files`)
      expect(validatePlanMarkdown(plan)).toContain('Every ```diff fence needs a repository-relative "path=".')
    }
  })

  it("rejects unsafe change paths and a missing test strategy", () => {
    const unsafe = (path: string) =>
      validStage.replace("### Files", `\`\`\`diff path=${path}\n@@ -1 +1 @@\n\`\`\`\n\n### Files`)

    expect(validatePlanMarkdown(unsafe("src/ok.ts"))).toEqual([])
    for (const path of ["/etc/passwd", "../outside.ts", "src/../../x.ts", "~/x.ts", "C:/x.ts"]) {
      expect(validatePlanMarkdown(unsafe(path))).toEqual([
        `Plan proposes a change to unsafe path "${path}".`
      ])
    }
    expect(validatePlanMarkdown(validStage.replace(/## Test strategy[\s\S]*/, ""))).toEqual([
      'Plan needs a "## Test strategy" section.'
    ])
    expect(validatePlanMarkdown(validStage.replace(/## Proposed flow[\s\S]*?## Ship auth/, "## Ship auth"))).toContain(
      "Plan needs a top-level Mermaid flow diagram."
    )
  })

  it("reports missing stage fields and malformed dependencies", () => {
    const errors = validatePlanMarkdown(`## Empty <!-- id: same -->\n\n## Again <!-- id: same -->\n> depends: missing, same\n`)
    expect(errors).toContain('Stage "Again" duplicates id "same".')
    expect(errors).toContain('Stage "Again" depends on unknown id "missing".')
    expect(errors).toContain("Stage dependencies contain a cycle.")
    expect(errors.some((error) => error.includes("Deliverable"))).toBe(true)
    expect(errors.some((error) => error.includes("User story"))).toBe(true)
    expect(errors.some((error) => error.includes("Definition of Done"))).toBe(true)
    expect(errors.some((error) => error.includes("Technical explanation"))).toBe(true)
    expect(errors.some((error) => error.includes("test path and named case"))).toBe(false)
  })
})
