import type { Meta, StoryObj } from "@storybook/react-vite"
import { AlertCircle, Server, Zap } from "lucide-react"
import { RuntimeRecoveryCard } from "./runtime-recovery-card.js"

const meta: Meta<typeof RuntimeRecoveryCard> = {
  title: "Composites/RuntimeRecoveryCard",
  component: RuntimeRecoveryCard,
  parameters: { layout: "centered" }
}

export default meta
type Story = StoryObj<typeof RuntimeRecoveryCard>

/** Three variants: MCP server (dismissable), Provider (required), Runtime (failed + Inspect). */
export const ThreeVariants: Story = {
  render: () => (
    <div className="flex w-[640px] flex-col gap-3 bg-panel p-4">
      <RuntimeRecoveryCard
        label="MCP server recovery"
        kind="MCP server"
        title="Reconnect runpod"
        message="The runpod MCP server needs authorization before its tools can run. Other tools keep working."
        icon={<Server size={13} />}
        actionLabel="Authorize"
        onAction={() => {}}
        onDismiss={() => {}}
      />

      <RuntimeRecoveryCard
        label="Provider recovery"
        kind="Provider"
        title="Choose a runtime connection"
        message="This migrated conversation is readable, but needs a certified connection and model before it can continue."
        icon={<Zap size={13} />}
        actionLabel="Open providers"
        onAction={() => {}}
      />

      <RuntimeRecoveryCard
        label="Runtime recovery"
        kind="Runtime"
        title="The agent process exited unexpectedly"
        message="Restart the runtime and check logs for details."
        icon={<AlertCircle size={13} />}
        failed
        actionLabel="Restart runtime"
        onAction={() => {}}
        inspectLabel="Inspect"
        onInspect={() => {}}
      />
    </div>
  )
}

/** MCP server variant: neutral body, dismissable, icon only red on failure. */
export const McpServer: Story = {
  args: {
    label: "MCP server recovery",
    kind: "MCP server",
    title: "Reconnect runpod",
    message: "The runpod MCP server needs authorization before its tools can run.",
    icon: <Server size={13} />,
    actionLabel: "Authorize",
    onAction: () => {},
    onDismiss: () => {}
  }
}

/** Provider variant: neutral body, required (no dismiss). */
export const Provider: Story = {
  args: {
    label: "Provider recovery",
    kind: "Provider",
    title: "Choose a runtime connection",
    message: "This migrated conversation is readable, but needs a certified connection and model before it can continue.",
    icon: <Zap size={13} />,
    actionLabel: "Open providers",
    onAction: () => {}
  }
}

/** Runtime variant: failed (red icon), Inspect action, neutral body. */
export const Runtime: Story = {
  args: {
    label: "Runtime recovery",
    kind: "Runtime",
    title: "The agent process exited unexpectedly",
    message: "Restart the runtime and check logs for details.",
    icon: <AlertCircle size={13} />,
    failed: true,
    actionLabel: "Restart runtime",
    onAction: () => {},
    inspectLabel: "Inspect",
    onInspect: () => {}
  }
}
