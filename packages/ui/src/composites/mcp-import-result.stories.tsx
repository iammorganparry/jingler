import type { Meta, StoryObj } from "@storybook/react-vite"
import { McpImportResult } from "./mcp-import-result.js"

const meta: Meta<typeof McpImportResult> = {
  title: "Composites/McpImportResult",
  component: McpImportResult,
  args: { onConnect: () => {}, onViewLog: () => {} },
  decorators: [(Story) => <div className="w-[420px] bg-panel p-4"><Story /></div>]
}
export default meta
type Story = StoryObj<typeof McpImportResult>

export const Success: Story = { args: { rows: [{ name: "docs", status: "imported" }] } }
export const NeedsAuth: Story = { args: { rows: [{ name: "linear", status: "needs-auth" }] } }
export const Failed: Story = { args: { rows: [{ name: "broken", status: "failed" }] } }
