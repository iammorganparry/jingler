import type { Meta, StoryObj } from "@storybook/react-vite"
import type { SessionCheckout } from "@jingler/core"
import { CheckoutSwitcher } from "./checkout-switcher.js"

const meta: Meta<typeof CheckoutSwitcher> = { title: "App/Checkout Switcher", component: CheckoutSwitcher }
export default meta
type Story = StoryObj<typeof CheckoutSwitcher>

const checkouts: ReadonlyArray<SessionCheckout> = [
  { id: "primary", repo: "org/api", branch: "feat/x", prNumber: 12 },
  { id: "c2", repo: "org/web", branch: "feat/x-ui", prNumber: 31 },
  { id: "c3", repo: "org/docs", branch: "feat/x-docs", prNumber: null }
]

/** Three repos: two with PRs (one green, one running), one with a branch only. */
export const MultiRepo: Story = {
  args: {
    checkouts,
    activeCheckoutId: "c2",
    prStates: { primary: { state: "open", checks: "pass" }, c2: { state: "draft", checks: "running" } },
    onSwitch: () => {}
  }
}
