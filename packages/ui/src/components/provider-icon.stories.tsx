import type { ProviderId } from "@jingler/core"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { ProviderIcon, providerLabel } from "./provider-icon.js"

const meta: Meta = { title: "Atoms/ProviderIcon" }
export default meta
type Story = StoryObj

const PROVIDERS = ["anthropic", "openai-codex", "opencode", "google", "openrouter"] as ProviderId[]

/** Compare with Paper board 22b (model popover): 14px marks; providers without a mark get a neutral letter tile. */
export const Providers: Story = {
  render: () => (
    <div className="flex flex-col gap-3 p-6">
      {PROVIDERS.map((providerId) => (
        <div key={providerId} className="flex items-center gap-3 text-xs text-muted-foreground">
          <ProviderIcon providerId={providerId} size={14} />
          <span>{providerLabel(providerId)}</span>
        </div>
      ))}
    </div>
  )
}
