import { describe, expect, it } from "vitest"
import { parseChecklist } from "./generated/checklist.ts"
import { parsePlanMarkdown } from "./plan-parse.ts"

const RICH_PLAN = `---
title: Auth replacement
revision: 2
---
Replace the auth flow with a deterministic implementation.

\`\`\`mermaid
graph TD; A-->B
\`\`\`

## Auth service <!-- id: stage-auth -->
Stand up the new auth service behind the existing route.

### Approach
- Add the module
- Delete the legacy flow

- [x] Add the service
  - [~] Wire the route
- [-] Migrate the tokens

### Acceptance
- [ ] Service tests green (test: src/auth.test.ts::issues tokens, rejects expired)

### Files
- \`src/auth.ts\` — A
- \`src/legacy.ts\` — D

> complexity: medium
> depends: stage-db

\`\`\`mermaid
sequenceDiagram
\`\`\`

## Database
Move sessions into Postgres.

- [ ] Write the migration
`

describe("parsePlanMarkdown", () => {
  it("keeps flat [DONE:n] numbering identical to parseChecklist", () => {
    const parsed = parsePlanMarkdown(RICH_PLAN)
    expect(parsed.checklist).toEqual(parseChecklist(RICH_PLAN))
    expect(parsed.checklist.map(({ step, text }) => [step, text])).toEqual([
      [1, "Add the service"],
      [2, "Wire the route"],
      [3, "Migrate the tokens"],
      [4, "Service tests green (test: src/auth.test.ts::issues tokens, rejects expired)"],
      [5, "Write the migration"]
    ])
  })

  it("parses frontmatter, overview blocks, and stage structure", () => {
    const parsed = parsePlanMarkdown(RICH_PLAN)
    expect(parsed.title).toBe("Auth replacement")
    expect(parsed.revision).toBe(2)
    expect(parsed.sections).toHaveLength(1)
    expect(parsed.sections[0].blocks.map((block) => block.kind)).toEqual([
      "prose",
      "diagram"
    ])

    expect(parsed.stages.map(({ id }) => id)).toEqual(["stage-auth", "database"])
    const auth = parsed.stages[0]
    expect(auth.title).toBe("Auth service")
    expect(auth.intent).toBe("Stand up the new auth service behind the existing route.")
    expect(auth.approach).toEqual(["Add the module", "Delete the legacy flow"])
    expect(auth.tasks).toEqual([
      {
        step: 1,
        text: "Add the service",
        status: "completed",
        subtasks: [{ step: 2, text: "Wire the route", status: "in-progress" }]
      },
      { step: 3, text: "Migrate the tokens", status: "blocked", subtasks: [] }
    ])
    expect(auth.acceptance).toEqual([{
      step: 4,
      text: "Service tests green",
      status: "pending",
      testReferences: [{ path: "src/auth.test.ts", cases: ["issues tokens", "rejects expired"] }]
    }])
    expect(auth.files).toEqual([
      { path: "src/auth.ts", change: "A" },
      { path: "src/legacy.ts", change: "D" }
    ])
    expect(auth.complexity).toBe("medium")
    expect(auth.dependencies).toEqual(["stage-db"])
    expect(auth.diagrams).toEqual(["sequenceDiagram"])
  })

  it("parses a plain flat checklist exactly as before", () => {
    const flat = "# Steps\n- [ ] One\n- [x] Two\n"
    const parsed = parsePlanMarkdown(flat)
    expect(parsed.title).toBe("Steps")
    expect(parsed.stages).toEqual([])
    expect(parsed.checklist).toEqual([
      { step: 1, text: "One", completed: false },
      { step: 2, text: "Two", completed: true }
    ])
  })

  it("falls back to the stage's plain bullets as approach without ### Approach", () => {
    const plan = "## Stage\nIntent line.\n\n- first step\n- second step\n\n- [ ] task\n"
    const stage = parsePlanMarkdown(plan).stages[0]
    expect(stage.approach).toEqual(["first step", "second step"])
    expect(stage.tasks.map(({ text }) => text)).toEqual(["task"])
  })
})
