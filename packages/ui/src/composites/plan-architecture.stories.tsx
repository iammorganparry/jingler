import type { PlanPrd } from "@jingler/core"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { PlanArchitecture } from "./plan-architecture.js"

/**
 * The read-only Architecture surface. `PlanArchitecture` takes the canonical
 * `PlanPrd` and derives its own view (`toPlanArchitectureView`), rendering the
 * prose sections and lifting every embedded mermaid diagram into the diagrams
 * region below. The "Empty" story pins the no-content state.
 */

const RICH_PRD: PlanPrd = {
  title: "Code review screen",
  sections: [
    {
      id: "context",
      title: "Context",
      blocks: [
        {
          kind: "prose",
          id: "context-1",
          text: "Reviewers currently jump between the diff and the plan doc to understand **why** a change exists. The architecture view gives them the plan's prose and diagrams in one read-only place."
        }
      ]
    },
    {
      id: "goals",
      title: "Goals",
      blocks: [
        {
          kind: "list",
          id: "goals-1",
          ordered: false,
          items: [
            "Surface Context / Goals / Technical design / Decisions as prose.",
            "Render embedded mermaid flow diagrams inline.",
            "Stay strictly read-only — no editing affordances."
          ]
        }
      ]
    },
    {
      id: "technical-design",
      title: "Technical design",
      blocks: [
        { kind: "prose", id: "td-1", text: "The projection lives in `@jingler/core` and is pure, so the UI is a thin render layer. Data flows one way:" },
        { kind: "diagram", id: "td-diagram", source: "graph LR; PRD --> View; View --> Sections; View --> Diagrams" }
      ]
    },
    {
      id: "decisions",
      title: "Decisions",
      blocks: [
        { kind: "prose", id: "dec-1", text: "Diagrams are aggregated into a single flat list rather than kept inline with their section, so the workflow surface can reuse the same id-stamped projection." },
        { kind: "diagram", id: "dec-diagram", source: "graph TD; Section --> Diagram; Stage --> Diagram" }
      ]
    }
  ],
  stages: [],
  annotations: []
}

const EMPTY_PRD: PlanPrd = {
  title: "Fresh plan",
  sections: [],
  stages: [],
  annotations: []
}

const meta = {
  title: "Composites/Plan Architecture",
  component: PlanArchitecture,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-3xl bg-canvas text-text-body">
        <Story />
      </div>
    )
  ]
} satisfies Meta<typeof PlanArchitecture>

export default meta
type Story = StoryObj<typeof meta>

/** A populated plan: four prose sections plus two mermaid diagrams. */
export const Rich: Story = {
  args: { prd: RICH_PRD }
}

/** No sections and no diagrams — the clean empty state. */
export const Empty: Story = {
  args: { prd: EMPTY_PRD }
}
