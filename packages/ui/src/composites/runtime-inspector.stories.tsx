import type { Meta, StoryObj } from "@storybook/react-vite"
import { FLOW_RUNTIME_DIAGNOSTIC } from "../storybook/product-flow/fixtures.js"
import { RuntimeInspector } from "./runtime-inspector.js"

const meta: Meta<typeof RuntimeInspector> = {
  title: "Settings/RuntimeInspector",
  component: RuntimeInspector,
  parameters: { layout: "fullscreen" },
  args: { snapshot: FLOW_RUNTIME_DIAGNOSTIC, loading: false, onRefresh: () => {}, onExport: () => {} }
}

export default meta
type Story = StoryObj<typeof RuntimeInspector>

export const Diagnostics: Story = {}
export const Exported: Story = { args: { exported: true } }
export const Empty: Story = { args: { snapshot: null } }
export const Failed: Story = { args: { snapshot: null, error: "Could not read runtime diagnostics." } }
