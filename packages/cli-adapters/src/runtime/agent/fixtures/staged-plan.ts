/** A minimal plan in the staged shape that passes `validatePlanMarkdown`. */
export const stagedPlan = (...tasks: string[]) => `## Proposed flow
\`\`\`mermaid
flowchart LR
  a --> b
\`\`\`

## Work <!-- id: work -->

### Deliverable
Work is done.

### User story
**As a** user
**I want** the work
**So that** I benefit

### Approach
- Do it.

${tasks.map((t) => `- [ ] ${t}`).join("\n")}

### Technical explanation
Plain.

### Acceptance
- [ ] second (test: a.test.ts::works)

### Definition of Done
- Tests pass

### Files
- \`a.ts\` — M

> complexity: low

## Test strategy
Unit.
`
