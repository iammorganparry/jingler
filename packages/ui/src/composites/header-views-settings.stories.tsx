import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { FileDiff, FolderTree, Globe, ListChecks, SquareTerminal, Waypoints } from "lucide-react"
import { HeaderViewsSettings } from "./header-views-settings.js"

const views = [
  { id: "changes", label: "Changes", icon: FileDiff },
  { id: "checks", label: "Checks", icon: ListChecks },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "browser", label: "Browser", icon: Globe },
  { id: "files", label: "Files", icon: FolderTree },
  { id: "plan", label: "Plan", icon: Waypoints }
]

const meta = { title: "Settings/Header views", parameters: { layout: "fullscreen" } } satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

const Page = ({ initial }: { initial: string[] }) => {
  const [pinned, setPinned] = useState<ReadonlyArray<string>>(initial)
  return (
    <div className="flex min-h-[600px] bg-editor">
      <HeaderViewsSettings views={views} pinned={pinned} onChange={setPinned} />
    </div>
  )
}

export const Default: Story = { render: () => <Page initial={["changes", "checks", "terminal"]} /> }
/** Five pinned: remaining toggles disabled, hint shown. */
export const Full: Story = { render: () => <Page initial={["changes", "checks", "terminal", "browser", "files"]} /> }
