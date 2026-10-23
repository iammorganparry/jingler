import type { Meta, StoryObj } from "@storybook/react-vite"
import type { Usage } from "@jingler/core"
import { UsageSettings } from "./usage-settings.js"

const resetsAt = new Date(Date.now() + 3_600_000).toISOString()
const usage = {
  fetchedAt: new Date().toISOString(),
  providers: [
    {
      providerId: "anthropic",
      name: "Claude",
      plan: "Max",
      available: true,
      windows: [
        { label: "Current session", utilization: 40, resetsAt, status: "ok" },
        { label: "Weekly", utilization: 85, resetsAt, status: "nearing" }
      ]
    }
  ]
} as unknown as Usage

const meta = { title: "Settings/Usage", component: UsageSettings, parameters: { layout: "fullscreen" } } satisfies Meta<typeof UsageSettings>
export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = { args: { usage } }
export const Loading: Story = { args: { usage: null, loading: true } }
