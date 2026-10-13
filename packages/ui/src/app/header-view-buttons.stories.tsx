import type { Meta, StoryObj } from "@storybook/react-vite"
import { FileDiff, Globe, ListChecks, SquareTerminal } from "lucide-react"
import { fn } from "storybook/test"
import { HeaderViewButtons, type HeaderViewItem } from "./header-view-buttons.js"

const meta = {
  title: "App/HeaderViewButtons",
  component: HeaderViewButtons,
  parameters: { layout: "centered" },
  args: { onOpen: fn() }
} satisfies Meta<typeof HeaderViewButtons>

export default meta
type Story = StoryObj<typeof meta>

const views: ReadonlyArray<HeaderViewItem> = [
  { id: "changes", label: "Changes", icon: FileDiff, count: "12", shortcut: "mod+shift+d" },
  { id: "checks", label: "Checks", icon: ListChecks, count: "3/4", shortcut: "mod+shift+p" },
  { id: "terminal", label: "Terminal", icon: SquareTerminal, shortcut: "ctrl+`" },
  { id: "browser", label: "Browser", icon: Globe, shortcut: "mod+shift+b" }
]

/** Board 04g: four pinned launchers; counts sit on one line beside the label. */
export const Default: Story = { args: { views } }

/** The open view is pressed in a neutral tone, never blue. */
export const WithOpenView: Story = { args: { views, activeId: "checks" } }
