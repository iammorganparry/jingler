import type { Meta, StoryObj } from "@storybook/react-vite"
import { StatusRow, Stepper } from "./status-row.js"

const meta: Meta = { title: "Atoms/StatusRow" }
export default meta
type Story = StoryObj

/** Neutral rows; only the failed one is red (boards 06, 16c). */
export const Rows: Story = {
  render: () => (
    <div className="flex w-[320px] flex-col gap-2 bg-panel p-4">
      <StatusRow>Connected · 12 tools</StatusRow>
      <StatusRow>Starting…</StatusRow>
      <StatusRow failed>Server exited with code 1</StatusRow>
    </div>
  )
}

/** Onboarding stepper: Folder ✓ · GitHub ● · Agent ○ (board 02). */
export const OnboardingStepper: Story = {
  render: () => (
    <div className="bg-panel p-4">
      <Stepper steps={["Folder", "GitHub", "Agent"]} current={1} />
    </div>
  )
}
