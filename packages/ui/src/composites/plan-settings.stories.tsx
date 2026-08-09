import type { Meta, StoryObj } from "@storybook/react"
import { PlanSettings } from "./plan-settings.js"

const meta = {
  title: "Composites/PlanSettings",
  component: PlanSettings,
  args: {
    source: JSON.stringify({
      title: "Enhanced plan",
      sections: [{ id: "tldr", title: "TL;DR", blocks: [] }],
      stages: [],
      annotations: []
    }, null, 2)
  }
} satisfies Meta<typeof PlanSettings>

export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
