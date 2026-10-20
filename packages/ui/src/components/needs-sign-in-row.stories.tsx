import type { Meta, StoryObj } from "@storybook/react-vite"
import { NeedsSignInRow } from "./needs-sign-in-row.js"

const meta: Meta = { title: "Atoms/NeedsSignInRow" }
export default meta
type Story = StoryObj

/** Import-review row for an OAuth server (board: MCP import review, #487). */
export const Default: Story = {
  render: () => (
    <div className="w-[320px] bg-panel p-4">
      <NeedsSignInRow host="https://linear.example/mcp" />
    </div>
  )
}
