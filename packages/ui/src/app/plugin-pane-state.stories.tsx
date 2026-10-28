import type { Meta, StoryObj } from "@storybook/react-vite"
import { PluginPaneState } from "./plugin-pane-state.js"

const meta = {
  title: "App/PluginPaneState",
  component: PluginPaneState,
  args: { pluginId: "pane-plugin", onRetry: () => {} },
  decorators: [(Story) => <div style={{ width: 280, height: 320 }} className="flex bg-panel"><Story /></div>]
} satisfies Meta<typeof PluginPaneState>

export default meta
type Story = StoryObj<typeof meta>

export const Loading: Story = { args: { variant: "loading" } }
export const Empty: Story = { args: { variant: "empty" } }
export const Crashed: Story = { args: { variant: "error", message: "Cannot read properties of undefined (reading 'repo')" } }
