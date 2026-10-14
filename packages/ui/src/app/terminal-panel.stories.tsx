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
    sessionId: "story",
    activeId: "t1",
    onSelect: () => {},
    onNew: () => {},
    onClose: () => {},
    onRestart: () => {},
    cwdLabel: "~/repos/jingler",
    renderTerminal: cell
  }
} satisfies Meta<typeof TerminalPanel>

export default meta
type Story = StoryObj<typeof meta>

const tabs: ReadonlyArray<TerminalTab> = [
  { id: "t1", title: "dev", status: "running" },
  { id: "t2", title: "test", status: "running" }
]

export const Tabs: Story = { args: { tabs, lastExit: 0 } }

export const Empty: Story = { args: { tabs: [], activeId: null } }

export const ShellExited: Story = {
  args: {
    tabs: [tabs[0] as TerminalTab, { id: "t2", title: "test", status: "exited", exitCode: 1 }],
    activeId: "t2",
    lastExit: 1
  }
}
