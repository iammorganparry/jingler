import type { Meta, StoryObj } from "@storybook/react-vite"
import { Field } from "./field.js"
import { Input } from "./input.js"
import { SettingsCard, SettingsRow } from "./settings-row.js"
import { Toggle } from "./toggle.js"

const meta: Meta = { title: "Molecules/Field" }
export default meta
type Story = StoryObj

/** MCP server form shape: labelled fields with help and an error, plus switch sizes. */
export const McpServerForm: Story = {
  render: () => (
    <div className="flex w-[420px] flex-col gap-4 bg-editor p-6">
      <Field label="Name" required>{(c) => <Input placeholder="paper" {...c} />}</Field>
      <Field label="Server URL" help="Streamable HTTP endpoint." required error="Enter a valid URL">{(c) => <Input defaultValue="not a url" {...c} />}</Field>
      <Field label="API key header" help="Sent with every request.">{(c) => <Input defaultValue="Authorization" {...c} />}</Field>
      <SettingsCard title="Switch sizes">
        <SettingsRow label="Default 28×16" control={<Toggle aria-label="Default" defaultChecked />} />
        <SettingsRow label="Small 24×14" control={<Toggle aria-label="Small" size="sm" />} />
      </SettingsCard>
    </div>
  )
}
