import type { Meta, StoryObj } from "@storybook/react-vite"
import { WorkflowSection } from "./workflow-section.js"

const meta: Meta = { title: "Composites/Workflow Section", parameters: { layout: "centered" } }
export default meta
type Story = StoryObj

const panel = (children: React.ReactNode) => (
  <div className="w-[352px] bg-panel">{children}</div>
)

/** Collapsed by default — a one-row summary until the operator opens it. */
export const Collapsed: Story = {
  render: () =>
    panel(
      <WorkflowSection
        lifecycle={{ status: "ready", updatedAt: "now" }}
        commands={[{ id: "dev", label: "Dev", command: "npm run dev" }]}
        runs={[]}
      />
    )
}

/** Expanded with a failed setup — Retry/Skip, same as the conversation workflow bar. */
export const SetupFailed: Story = {
  render: () =>
    panel(
      <div className="[&_details]:open:block">
        <WorkflowSection
          lifecycle={{ status: "setup-failed", updatedAt: "now", error: "Command exited with code 1." }}
          commands={[{ id: "dev", label: "Dev", command: "npm run dev" }]}
          runs={[]}
        />
      </div>
    ),
  play: async ({ canvasElement }) => {
    const details = canvasElement.querySelector("details")
    if (details) details.open = true
  }
}
