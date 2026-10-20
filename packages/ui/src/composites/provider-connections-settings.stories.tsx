import { ProviderCatalog, type ProviderConnectionId, type ProviderModelId } from "@jingler/core"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { Schema } from "effect"
import { ProviderConnectionsSettings } from "./provider-connections-settings.js"

const meta: Meta = { title: "Composites/ProviderConnectionsSettings" }
export default meta
type Story = StoryObj

const catalog = Schema.decodeSync(ProviderCatalog)({
  connections: [
    {
      connection: {
        id: "claude-max",
        providerId: "anthropic",
        authKind: "claude-setup-token",
        account: { fingerprint: "account-ab12", displayLabel: "Morgan @ Max" },
        targetId: "desktop",
        status: "authenticated",
        subscription: {
          entitlement: "active",
          planLabel: "Max",
          expiresAt: null,
          quotaLabel: null,
          rateLimitLabel: null,
          confirmedBillingRoute: "subscription"
        },
        createdAt: "2026-08-10T08:00:00.000Z",
        updatedAt: "2026-08-10T08:00:00.000Z"
      },
      models: [
        {
          providerId: "anthropic",
          id: "anthropic/claude-test",
          label: "Claude Test",
          capabilities: { contextWindow: 200_000, reasoning: ["low", "medium", "high"], vision: true },
          verification: "certified",
          selectable: true,
          certificationKey: "current-certification"
        }
      ]
    },
    {
      connection: {
        id: "codex-plus",
        providerId: "openai-codex",
        authKind: "openai-codex-oauth",
        account: { fingerprint: "account-cd34", displayLabel: "Morgan @ Plus" },
        targetId: "desktop",
        status: "authenticated",
        subscription: {
          entitlement: "active",
          planLabel: "Plus",
          expiresAt: null,
          quotaLabel: null,
          rateLimitLabel: null,
          confirmedBillingRoute: "subscription"
        },
        createdAt: "2026-08-10T08:00:00.000Z",
        updatedAt: "2026-08-10T08:00:00.000Z"
      },
      models: [
        {
          providerId: "openai-codex",
          id: "openai-codex/gpt-test",
          label: "GPT Test",
          capabilities: { contextWindow: 128_000, reasoning: ["low", "medium"], vision: false },
          verification: "certified",
          selectable: true,
          certificationKey: "current-certification"
        }
      ]
    }
  ],
  refreshedAt: "2026-08-10T08:00:00.000Z",
  stale: false
})

/** The two subscription connections each show their real brand logo and a `Sign out` control; the default row carries the star. */
export const MultipleAccounts: Story = {
  render: () => (
    <div className="flex h-[480px] w-[900px] bg-editor">
      <ProviderConnectionsSettings
        catalog={catalog}
        defaultConnectionId={"claude-max" as ProviderConnectionId}
        defaultModelId={"anthropic/claude-test" as ProviderModelId}
        onRefresh={() => {}}
        onVerify={() => {}}
        onMakeDefault={() => {}}
        onLogout={() => {}}
        onConnectClaude={() => {}}
        onStartCodex={() => {}}
        onSetApiKey={() => {}}
        onCancelLogin={async () => {}}
        onSaveApiKey={async () => ({ ok: true })}
      />
    </div>
  )
}
