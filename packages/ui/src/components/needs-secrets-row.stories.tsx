import type { Meta, StoryObj } from "@storybook/react-vite"
import { NeedsSecretsRow } from "./needs-secrets-row.js"

const meta: Meta = { title: "Atoms/NeedsSecretsRow" }
export default meta
type Story = StoryObj

/** Import-review row for a candidate missing an env/header secret value (board: MCP import review, #487). */
export const Default: Story = {
  render: () => (
    <div className="w-[320px] bg-panel p-4">
      <NeedsSecretsRow />
    </div>
  )
}
