import type { ProviderId } from "@jingler/core"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { HarnessCard, type HarnessStatus } from "./harness-card.js"

const meta: Meta = { title: "Composites/HarnessCard", parameters: { layout: "centered" } }
export default meta
type Story = StoryObj

const card = (status: HarnessStatus) => (
  <div className="w-[480px] bg-panel p-4">
    <HarnessCard providerId={"anthropic" as ProviderId} name="Claude Code" detail="local CLI" status={status} />
  </div>
)

export const Ready: Story = { render: () => card("ready") }
export const SigningIn: Story = { render: () => card("signing-in") }
export const NeedsAttention: Story = { render: () => card("needs-attention") }
export const SignedOut: Story = { render: () => card("signed-out") }
