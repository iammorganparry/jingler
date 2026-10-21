import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  ProviderAccountChoice,
  ProviderLimitBanner,
  ProviderResumeCard,
  ProviderSignedOutCard
} from "./provider-recovery-cards.js"

const meta: Meta = {
  title: "Composites/ProviderRecoveryCards",
  parameters: { layout: "centered" }
}
export default meta
type Story = StoryObj

export const SignedOut: Story = {
  render: () => (
    <div className="w-[640px] bg-panel">
      <ProviderSignedOutCard
        title="Claude Code signed out during this run"
        message="Reconnect to continue. A subscription never falls back to an API key."
        onReconnect={() => {}}
      />
    </div>
  )
}

export const Reconnected: Story = {
  render: () => (
    <div className="w-[640px] bg-panel">
      <ProviderResumeCard onResume={() => {}} />
    </div>
  )
}

export const UsageLimit: Story = {
  render: () => (
    <div className="w-[640px] bg-panel">
      <ProviderLimitBanner limit="Limited until 16:40" onSwitchModel={() => {}} onSwitchAccount={() => {}} />
    </div>
  )
}

export const AmbiguousAccounts: Story = {
  render: () => (
    <div className="w-[640px] bg-panel">
      <ProviderAccountChoice
        accounts={[
          { id: "a", label: "work@example.com" },
          { id: "b", label: "personal@example.com" }
        ]}
        onUse={() => {}}
      />
    </div>
  )
}
