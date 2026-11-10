import type { Meta, StoryObj } from "@storybook/react-vite"
import type { McpConnectorRow } from "./mcp-connectors.js"
import { McpAddServerDialog, McpServerDrawer } from "./mcp-server-drawer.js"

const sentry: McpConnectorRow = {
  id: "sentry",
  displayName: "Sentry",
  iconUrl: null,
  target: "http · mcp.sentry.dev/mcp",
  source: "jingler",
  agents: "Claude, Codex, Pi",
  state: "needs-auth",
  toolCount: null,
  enabled: true
}

const noop = () => {}
const drawer = {
  row: sentry,
  onOpenChange: noop,
  toolNames: ["search_issues", "get_issue_details", "update_issue", "list_releases"],
  disabledTools: ["update_issue"],
  onToggleTool: noop,
  onEnabledChange: noop,
  onReconnect: noop,
  onTest: noop,
  onRemove: noop,
  logLines: ["POST /mcp → 401 Unauthorized"],
  lastCheck: "POST /mcp → 401 Unauthorized · 2m ago"
}

const meta: Meta<typeof McpServerDrawer> = {
  title: "Composites/McpServerDrawer",
  component: McpServerDrawer,
  parameters: { layout: "fullscreen" }
}
export default meta
type Story = StoryObj<typeof McpServerDrawer>

/** 25c · Jingler server that answered 401: Reconnect through OAuth. */
export const NeedsSignIn: Story = { args: drawer }

/** 25c · Connected server with per-tool toggles. */
export const Connected: Story = { args: { ...drawer, row: { ...sentry, state: "connected", toolCount: 4 }, lastCheck: "tools/list → 4 tools · just now" } }

/** 25c · claude.ai connector: sign-in lives on claude.ai, Remove disabled. */
export const ClaudeAiConnector: Story = {
  args: { ...drawer, row: { ...sentry, id: "linear", displayName: "Linear", target: "mcp.linear.app/mcp", source: "claude.ai", agents: "Claude" } }
}

/** 25d · Add server with trust note and a way back to Discover. */
export const AddServer: StoryObj<typeof McpAddServerDialog> = {
  render: () => <McpAddServerDialog open onOpenChange={noop} add={async () => {}} setApiKey={async () => {}} onBrowse={noop} />
}
