import type { Meta, StoryObj } from "@storybook/react-vite"
import type { Usage } from "@jingler/core"
import { UsageModal } from "./usage-modal.js"

const meta = {
  title: "Composites/UsageModal",
  component: UsageModal,
  parameters: { layout: "fullscreen" }
} satisfies Meta<typeof UsageModal>

export default meta
type Story = StoryObj<typeof meta>

/** Enterprise / API-priced login: spend rows, no percentage bars. */
export const ApiPricing: Story = {
  args: {
    open: true,
    usage: {
      fetchedAt: "2026-10-13T12:00:00.000Z",
      providers: [{
        name: "Claude",
        plan: "Enterprise · API pricing",
        available: true,
        billingRoute: "api",
        windows: [],
        spend: {
          lastSession: { tokens: 12_500, costUsd: 1.23 },
          today: { tokens: 480_000, costUsd: 4.5 },
          month: { tokens: 9_200_000, costUsd: 61.07 }
        }
      }]
    } as unknown as Usage
  }
}
