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
      markdown:
        "<p>Reviewers currently jump between the diff and the plan doc to " +
        "understand <strong>why</strong> a change exists. The architecture view " +
        "gives them the plan's prose and diagrams in one read-only place.</p>"
    },
    {
      id: "goals",
      title: "Goals",
      markdown:
        "<ul><li>Surface Context / Goals / Technical design / Decisions as prose.</li>" +
        "<li>Render embedded mermaid flow diagrams inline.</li>" +
        "<li>Stay strictly read-only — no editing affordances.</li></ul>"
    },
    {
      id: "technical-design",
      title: "Technical design",
      markdown:
        "<p>The projection lives in <code>@jingler/core</code> and is pure, so the " +
        "UI is a thin render layer. Data flows one way:</p>" +
        '<div data-diagram="mermaid"><pre>graph LR; PRD --&gt; View; View --&gt; Sections; View --&gt; Diagrams</pre></div>'
    },
    {
      id: "decisions",
      title: "Decisions",
      markdown:
        "<p>Diagrams are aggregated into a single flat list rather than kept " +
        "inline with their section, so the workflow surface can reuse the same " +
        "id-stamped projection.</p>" +
        '<div data-diagram="mermaid"><pre>graph TD; Section --&gt; Diagram; Stage --&gt; Diagram</pre></div>'
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
