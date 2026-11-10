import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  McpComposerMenu,
  McpConnectorsView,
  type McpCatalogEntry,
  type McpConnectorRow
} from "./mcp-connectors.js"

const row = (over: Partial<McpConnectorRow> & Pick<McpConnectorRow, "id" | "displayName">): McpConnectorRow => ({
  iconUrl: null,
  target: "mcp.example.com/mcp",
  source: "jingler",
  agents: "All agents",
  state: "connected",
  toolCount: 12,
  enabled: true,
  ...over
})

/** Mirrors the operator's real setup (claude.ai, plugin and Jingler servers). */
const ROWS: ReadonlyArray<McpConnectorRow> = [
  row({ id: "linear", displayName: "Linear", target: "mcp.linear.app/mcp", source: "claude.ai", agents: "Claude", state: "needs-auth", toolCount: null }),
  row({ id: "posthog", displayName: "PostHog", target: "mcp.posthog.com/mcp", source: "claude.ai", agents: "Claude", state: "needs-auth", toolCount: null }),
  row({ id: "sentry", displayName: "Sentry", target: "mcp.sentry.dev/mcp", state: "needs-auth", toolCount: null }),
  row({ id: "slack", displayName: "Slack", target: "mcp.slack.com/mcp", source: "claude.ai", agents: "Claude", state: "needs-auth", toolCount: null }),
  row({ id: "supabase-gtm", displayName: "Supabase - GTM Grid", target: "mcp.supabase.com/mcp", source: "claude.ai", agents: "Claude", toolCount: 32 }),
  row({ id: "supabase-prod", displayName: "Supabase - Trigify Prod", target: "mcp.supabase.com/mcp", source: "claude.ai", agents: "Claude", toolCount: 32 }),
  row({ id: "paper", displayName: "paper", target: "127.0.0.1:29979/mcp", toolCount: 24 }),
  row({ id: "chrome", displayName: "Claude in Chrome", target: "local", state: "local-only", toolCount: null, enabled: false }),
  row({ id: "notion", displayName: "notion", note: "Provided by the engineering plugin", source: "plugin", state: "pending", toolCount: null, enabled: false })
]

const entry = (over: Partial<McpCatalogEntry> & Pick<McpCatalogEntry, "id" | "displayName" | "origin">): McpCatalogEntry => ({
  iconUrl: null,
  description: "",
  registryName: "",
  kind: "Remote · OAuth",
  ...over
})

const CATALOG: ReadonlyArray<McpCatalogEntry> = [
  entry({ id: "ca-linear", origin: "claude.ai", displayName: "Linear", description: "Issues, projects and cycles.", registryName: "claude.ai Linear", kind: "Org", added: "needs-auth" }),
  entry({ id: "ca-gtm", origin: "claude.ai", displayName: "Supabase - GTM Grid", description: "Shared by your org admin.", registryName: "claude.ai Supabase - GTM Grid", kind: "Org", added: "connected" }),
  entry({ id: "cc-notion", origin: "claude-code", displayName: "notion", description: "From the engineering plugin.", registryName: "plugin:engineering:notion" }),
  entry({ id: "cc-obsidian", origin: "claude-code", displayName: "obsidian", description: "Local vault notes.", registryName: "~/.claude.json", kind: "Local · stdio" }),
  entry({ id: "cx-context7", origin: "codex", displayName: "context7", description: "Up-to-date library docs.", registryName: "~/.codex/config.toml", kind: "Remote" }),
  entry({ id: "rg-github", origin: "registry", displayName: "GitHub", description: "Repos, issues, pull requests and Actions runs.", registryName: "io.github.github/github-mcp-server" }),
  entry({ id: "rg-sentry", origin: "registry", displayName: "Sentry", description: "Issues, events and releases.", registryName: "io.sentry/mcp", added: "needs-auth" }),
  entry({ id: "rg-playwright", origin: "registry", displayName: "Playwright", description: "Drive a real browser.", registryName: "@playwright/mcp", kind: "Local · npx" })
]

const noop = () => {}
const viewProps = {
  rows: ROWS,
  catalog: CATALOG,
  onReconnect: noop,
  onOpen: noop,
  onAddCustom: noop,
  onAddFromCatalog: noop
}

const meta: Meta<typeof McpConnectorsView> = {
  title: "Composites/McpConnectors",
  component: McpConnectorsView,
  parameters: { layout: "padded" }
}
export default meta
type Story = StoryObj<typeof McpConnectorsView>

/** 25a · Yours: one table across sources, inline Reconnect, sign-in banner. */
export const Yours: Story = { args: viewProps }

/** 25a · Nothing needs sign-in: no banner. */
export const AllConnected: Story = {
  args: { ...viewProps, rows: ROWS.filter((candidate) => candidate.state !== "needs-auth") }
}

/** 25a · Tool budget warning past ~80 tools. */
export const OverToolBudget: Story = {
  args: { ...viewProps, rows: ROWS.map((candidate) => ({ ...candidate, toolCount: candidate.toolCount === null ? null : candidate.toolCount * 2 })) }
}

/** 25b · Discover: claude.ai, Claude Code and Codex servers above the registry. */
export const Discover: Story = { args: { ...viewProps, initialTab: "discover" } }

/** 25b · Registry still loading. */
export const DiscoverLoading: Story = { args: { ...viewProps, initialTab: "discover", catalogLoading: true } }

/** 25e · Composer `+ › MCP` submenu: per-chat toggles, then "Reconnect" rows. */
export const ComposerMenu: StoryObj<typeof McpComposerMenu> = {
  render: () => (
    <McpComposerMenu rows={ROWS} onToggle={noop} onReconnect={noop} onBrowse={noop} onManage={noop} reconnectLimit={3} />
  )
}
