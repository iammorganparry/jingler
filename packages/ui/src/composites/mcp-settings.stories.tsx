import type { Meta, StoryObj } from "@storybook/react-vite"
import type { McpServer } from "@jingler/core"
import { McpSettings, type McpSettingsProps } from "./mcp-settings.js"

const server = (over: Partial<McpServer>): McpServer => ({
  name: "context7",
  displayName: "Context7",
  iconUrl: null,
  authKind: "none",
  authState: "ready",
  transport: "http",
  scope: "user",
  target: "https://mcp.context7.com/mcp",
  envKeys: [],
  headerKeys: [],
  enabled: true,
  ...over
})

const base: McpSettingsProps = {
  servers: [],
  parseError: null,
  loading: false,
  statuses: null,
  probing: false,
  probe: () => {},
  setEnabled: async () => {},
  setAuth: async () => {},
  setDisabledTools: async () => {},
  signOut: async () => {},
  remove: async () => {},
  add: async () => {},
  setApiKey: async () => {},
  startAuthorization: async () => {},
  reveal: async () => {},
  logTail: async () => ({ lines: [] }),
  importCandidates: async () => [],
  applyImport: async () => []
}

const meta = {
  title: "Settings/McpSettings",
  component: McpSettings,
  args: base,
  decorators: [(Story) => <div className="h-[640px] w-[860px] overflow-auto bg-editor p-8"><Story /></div>]
} satisfies Meta<typeof McpSettings>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {}

export const List: Story = {
  args: {
    servers: [
      server({}),
      server({ name: "linear", displayName: "Linear", authKind: "oauth", authState: "needs-auth", target: "https://mcp.linear.app/mcp" }),
      server({ name: "fs", displayName: "Filesystem", transport: "stdio", target: "npx -y @modelcontextprotocol/server-filesystem", enabled: false })
    ],
    statuses: [
      { name: "context7", scope: "user", state: "connected", toolCount: 3, toolNames: [], error: null, checkedAt: "2026-10-12T00:00:00.000Z" },
      { name: "fs", scope: "user", state: "failed", toolCount: null, toolNames: [], error: "spawn npx ENOENT", checkedAt: "2026-10-12T00:00:00.000Z" }
    ]
  }
}

export const ParseError: Story = { args: { parseError: "Unexpected token } at line 4" } }

/** Add-server dialog: open it from the empty state's CTA. */
export const AddForm: Story = {
  play: async ({ canvasElement }) => {
    const cta = [...canvasElement.querySelectorAll("button")].find((b) => b.textContent === "Add server")
    cta?.click()
  }
}

export const AddFormError: Story = {
  args: { add: async () => { throw new Error("cannot write config") } },
  play: AddForm.play
}
