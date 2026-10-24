import type { Meta, StoryObj } from "@storybook/react-vite"
import { TerminalPanel, type TerminalTab } from "./terminal-panel.js"

const cell = (id: string) => (
  <div className="h-full p-3 font-mono text-xs text-text">$ terminal cell for {id}</div>
)

const meta = {
  title: "App/TerminalPanel",
  component: TerminalPanel,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex h-[640px] w-[1000px] bg-editor">
        <Story />
      </div>
    )
  ],
  args: {
    tab: { id: "t1", title: "dev", status: "running" } as TerminalTab,
    onRestart: () => {},
    cwdLabel: "~/repos/jingler",
    renderTerminal: cell
  }
} satisfies Meta<typeof TerminalPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Running: Story = {}

export const ShellExited: Story = {
  args: { tab: { id: "t2", title: "test", status: "exited", exitCode: 1 } }
}
