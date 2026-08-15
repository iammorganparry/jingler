import type { Meta, StoryObj } from "@storybook/react"
import { WebSearchSettings } from "./web-search-settings.js"

const meta = {
  title: "Settings/WebSearch",
  component: WebSearchSettings,
  parameters: {
    layout: "centered"
  },
  decorators: [
    (Story) => (
      <div className="w-[620px] rounded-xl bg-background p-6 text-foreground">
        <Story />
      </div>
    )
  ],
  args: {
    busy: false,
    error: null,
    loading: false,
    onSave: async () => {},
    onClear: async () => {},
    onSkip: async () => {}
  }
} satisfies Meta<typeof WebSearchSettings>

export default meta
type Story = StoryObj<typeof meta>

export const Pending: Story = {
  args: {
    status: {
      config: { setup: "pending", provider: null },
      credentials: [
        { provider: "exa", configured: false, cloudSynced: false, validatedAt: null },
        { provider: "firecrawl", configured: false, cloudSynced: false, validatedAt: null }
      ]
    }
  }
}

export const ConfiguredAndSynced: Story = {
  args: {
    status: {
      config: { setup: "configured", provider: "exa" },
      credentials: [
        {
          provider: "exa",
          configured: true,
          cloudSynced: true,
          validatedAt: "2026-08-14T17:00:00.000Z"
        },
        { provider: "firecrawl", configured: false, cloudSynced: false, validatedAt: null }
      ]
    }
  }
}

export const CloudSyncUnavailable: Story = {
  args: {
    status: {
      config: { setup: "configured", provider: "firecrawl" },
      credentials: [
        { provider: "exa", configured: false, cloudSynced: false, validatedAt: null },
        {
          provider: "firecrawl",
          configured: true,
          cloudSynced: false,
          validatedAt: "2026-08-14T17:00:00.000Z"
        }
      ]
    }
  }
}
