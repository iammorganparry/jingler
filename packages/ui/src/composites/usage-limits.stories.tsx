import type { Meta, StoryObj } from "@storybook/react-vite"
import { UsageLimits } from "./usage-limits.js"

const meta = {
  title: "Composites/UsageLimits",
  component: UsageLimits,
  decorators: [(Story) => <div className="w-[260px] rounded-lg border border-line bg-sunken"><Story /></div>]
} satisfies Meta<typeof UsageLimits>

export default meta
type Story = StoryObj<typeof meta>

const inOneHour = new Date(Date.now() + 3_600_000).toISOString()

/** A limited session window names its reset time; the weekly window stays neutral. */
export const Limited: Story = {
  args: {
    usage: {
      fetchedAt: null,
      providers: [
        {
          name: "Anthropic",
          plan: "Max",
          available: true,
          windows: [
            { label: "Current session", resetsAt: inOneHour, utilization: 100, status: "limited" },
            { label: "Weekly · all models", resetsAt: inOneHour, utilization: 42, status: "ok" }
          ]
        }
      ]
    }
  }
}

export const Loading: Story = { args: { usage: null, loading: true } }
export const Empty: Story = { args: { usage: null } }
