import type { Meta, StoryObj } from "@storybook/react-vite"
import type { McpServer } from "@jingler/core"
import { McpServerDetailDialog } from "./mcp-server-detail-dialog.js"

const SERVER: McpServer = {
  name: "runpod",
  displayName: "RunPod",
  iconUrl: null,
  authKind: "oauth",
  authState: "ready",
  transport: "http",
  scope: "user",
  target: "https://runpod.example/mcp",
  envKeys: [],
  headerKeys: [],
  enabled: true,
  disabledTools: ["dangerous_delete"]
}

const meta = {
  title: "Composites/McpServerDetailDialog",
  component: McpServerDetailDialog,
  args: {
    server: SERVER,
    open: true,
    onOpenChange: () => {},
    toolCount: 2,
    toolNames: ["list_pods", "dangerous_delete"],
    logLines: ["[info] connected", "[info] tools/list ok"],
    logLoading: false,
    oauthAccount: "morgan@trigify.io",
    disabledTools: ["dangerous_delete"],
    onToggleTool: () => {},
    onSignOut: () => {}
  }
} satisfies Meta<typeof McpServerDetailDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const LoadingLog: Story = { args: { logLines: [], logLoading: true } }

export const NoOAuth: Story = { args: { oauthAccount: null, onSignOut: undefined } }

export const BeforeFirstProbe: Story = {
  args: { toolCount: null, toolNames: [], disabledTools: [] }
}

export const AllToolsEnabled: Story = { args: { disabledTools: [] } }
