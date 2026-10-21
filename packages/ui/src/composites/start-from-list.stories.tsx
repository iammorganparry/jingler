import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"
import { LinearMark } from "../components/linear-mark.js"
import { StartFromList } from "./start-from-list.js"

const meta = {
  title: "Composites/StartFromList",
  component: StartFromList,
  args: {
    kind: "issue", icon: <LinearMark className="size-[15px]" />, label: "Linear issue", search: "", mine: true,
    pullRequests: [], issues: [], selectedPr: null, selectedIssue: null, loading: false, error: null,
    providerConnected: true, linkedSessions: [], onSearch: fn(), onMine: fn(), onRetry: fn(), onConnect: fn(),
    onOpenSession: fn(), onPr: fn(), onIssue: fn()
  }
} satisfies Meta<typeof StartFromList>
export default meta
type Story = StoryObj<typeof meta>

export const NotConnected: Story = { args: { providerConnected: false } }
export const Loading: Story = { args: { loading: true } }
export const NoAssignedIssues: Story = {}
export const LoadFailed: Story = { args: { error: "boom" } }
export const AlreadyOpen: Story = { args: { linkedSessions: [{ id: "s1", title: "Fix login" }] } }
