import type { Meta, StoryObj } from "@storybook/react-vite"
import { FileDiff, FolderTree, Globe, ListChecks, NotebookPen, SquareTerminal, Waypoints } from "lucide-react"
import { useState } from "react"
import { fn } from "storybook/test"
import type { HeaderViewItem } from "./header-view-buttons.js"
import { ViewOverflowMenu } from "./view-overflow-menu.js"

const views: ReadonlyArray<HeaderViewItem> = [
  { id: "changes", label: "Changes", icon: FileDiff },
  { id: "checks", label: "Checks", icon: ListChecks },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "browser", label: "Browser", icon: Globe },
  { id: "files", label: "Files", icon: FolderTree },
  { id: "plan", label: "Plan", icon: Waypoints },
  { id: "linear.issues", label: "Linear issues", icon: NotebookPen, plugin: true }
]

const meta = {
  title: "App/ViewOverflowMenu",
  component: ViewOverflowMenu,
  parameters: { layout: "centered" },
  args: { views, pinned: ["changes", "checks", "terminal", "browser"], onOpen: fn(), onPinnedChange: fn() }
} satisfies Meta<typeof ViewOverflowMenu>

export default meta
type Story = StoryObj<typeof meta>

/** Board 04g: Views and Plugins sections, each row with "Pin to header". Click ⋯ to open. */
export const Default: Story = {}

/** Five pinned: pinning a sixth is refused, with a tooltip on the toggle. */
export const HeaderFull: Story = { args: { pinned: ["changes", "checks", "terminal", "browser", "files"] } }

/** Pin state held locally so toggles can be tried. */
export const Interactive: Story = {
  render: (args) => {
    const [pinned, setPinned] = useState(args.pinned)
    return <ViewOverflowMenu {...args} pinned={pinned} onPinnedChange={setPinned} />
  }
}
