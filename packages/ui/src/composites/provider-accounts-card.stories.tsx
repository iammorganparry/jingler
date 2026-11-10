import { ProviderId } from "@jingler/core"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { ChevronDown } from "lucide-react"
import type { ReactElement } from "react"
import { Button } from "../components/button.js"
import { EntitlementWarning, NativeLoginHint, ProviderAccountsCard } from "./provider-accounts-card.js"

const meta: Meta = { title: "Composites/ProviderAccountsCard" }
export default meta
type Story = StoryObj

const noop = () => {}

const ClaudeCard = () => (
  <ProviderAccountsCard
    providerId={ProviderId.make("anthropic")}
    name="Claude Code"
    status="ready"
    detail="2 accounts · subscription"
    trailing={
      <Button variant="outline" size="sm" className="bg-panel">
        <span className="text-dim">Default model</span> Opus 5.5 <ChevronDown size={14} className="text-dim" />
      </Button>
    }
    accounts={[
      { id: "work", label: "morgan@trigify.io", plan: "Max" },
      { id: "personal", label: "morgan@personal.dev", plan: "Pro" }
    ]}
    defaultAccountId="work"
    onMakeDefault={noop}
    onSignOut={noop}
    onAddAccount={noop}
  />
)

const CodexCard = () => (
  <ProviderAccountsCard
    providerId={ProviderId.make("openai-codex")}
    name="Codex"
    status="needs-attention"
    detail="Signed in as morgan@trigify.io"
  >
    <EntitlementWarning
      message="Signed in, but the plan couldn't be confirmed. Codex sessions may be refused until it is."
      onRetry={noop}
      onUseAnother={noop}
    />
  </ProviderAccountsCard>
)

const OpenCodeCard = () => (
  <ProviderAccountsCard
    providerId={ProviderId.make("opencode")}
    name="OpenCode"
    status="native"
    detail="Native login on this device"
  >
    <NativeLoginHint command="opencode auth login" onRefresh={noop} />
  </ProviderAccountsCard>
)

/** Board 15d · Providers · accounts — all three cards in the 720 content column. */
export const Board15d: Story = {
  render: () => (
    <div className="flex w-[720px] flex-col gap-4 bg-canvas p-6">
      <div>
        <h2 className="text-[20px] font-semibold text-text-bright">Providers</h2>
        <p className="mt-1 text-[12px] text-muted-foreground">
          Sign in to the agents Jingler can run, and pick a default model for each.
        </p>
      </div>
      <ClaudeCard />
      <CodexCard />
      <OpenCodeCard />
    </div>
  )
}

const frame = (card: ReactElement) => <div className="w-[720px] bg-canvas p-6">{card}</div>
export const MultipleAccounts: Story = { render: () => frame(<ClaudeCard />) }
export const EntitlementNeedsAttention: Story = { render: () => frame(<CodexCard />) }
export const OpenCodeNativeHint: Story = { render: () => frame(<OpenCodeCard />) }
