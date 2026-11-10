import type { Meta, StoryObj } from "@storybook/react-vite"
import { TerminalFind } from "./terminal-find.js"

const meta = {
  title: "App/TerminalFind",
  component: TerminalFind,
  args: { query: "connection timeout", count: "2 of 12", onChange: () => {} },
  render: (args) => <div className="relative h-[180px] w-[720px] bg-sunken"><TerminalFind {...args} /></div>
} satisfies Meta<typeof TerminalFind>
export default meta
type Story = StoryObj<typeof meta>
export const Matches: Story = {}
export const Empty: Story = { args: { query: "", count: "" } }
export const NoMatches: Story = { args: { count: "No matches" } }
export const NarrowPane: Story = { render: (args) => <div className="relative h-[180px] w-[280px] bg-sunken"><TerminalFind {...args} /></div> }
