import * as React from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  Archive,
  FileDiff,
  GitPullRequest,
  LogOut,
  MonitorPlay,
  Settings,
  SquareTerminal,
  TerminalSquare
} from "lucide-react"
import { Button } from "../components/button.js"
import { CommandPalette } from "./command-palette.js"
import type { PaletteItem } from "./command-palette-model.js"

/**
 * The palette with the item set `StarbaseApp` actually builds, so grouping,
 * hints and the empty state can be iterated without launching Electron.
 *
 * `run` is a no-op here on purpose: the whole value of the split is that this
 * story needs no sessions, no RPC and no auth to render the thing you are
 * looking at.
 */
const meta = {
  title: "App/CommandPalette",
  component: CommandPalette
} satisfies Meta<typeof CommandPalette>

export default meta
type Story = StoryObj<typeof meta>

const noop = () => {}

const session = (id: string, label: string, repo: string, branch: string): PaletteItem => ({
  id,
  kind: "session",
  label,
  detail: `${repo} · ${branch}`,
  group: "Sessions",
  run: noop
})

const ITEMS: ReadonlyArray<PaletteItem> = [
  session("s1", "refactor auth", "starbase", "feat/auth"),
  session("s2", "theme tokens", "starbase", "feat/theme"),
  session("s3", "session sidebar filters", "starbase", "feat/sidebar"),
  session("s4", "fix flaky terminal spec", "starbase", "fix/terminal"),
  {
    id: "a-new",
    kind: "action",
    label: "New Session",
    group: "Actions",
    hint: "⌘N",
    icon: SquareTerminal,
    run: noop
  },
  {
    id: "a-terminal",
    kind: "action",
    label: "Toggle Terminal",
    group: "Actions",
    hint: "⌃`",
    icon: TerminalSquare,
    run: noop
  },
  {
    id: "a-browser",
    kind: "action",
    label: "Toggle Browser",
    group: "Actions",
    hint: "⌃⇧B",
    icon: MonitorPlay,
    run: noop
  },
  {
    id: "a-archive",
    kind: "action",
    label: "Archive Session",
    detail: "refactor auth",
    group: "Actions",
    icon: Archive,
    run: noop
  },
  {
    id: "a-settings",
    kind: "action",
    label: "Open Settings",
    group: "Actions",
    icon: Settings,
    run: noop
  },
  {
    id: "a-signout",
    kind: "action",
    label: "Sign out",
    group: "Actions",
    icon: LogOut,
    run: noop
  },
  {
    id: "t-changes",
    kind: "tab",
    label: "Go to Changes",
    group: "Go to tab",
    icon: FileDiff,
    run: noop
  },
  {
    id: "t-pr",
    kind: "tab",
    label: "Go to Pull Request",
    group: "Go to tab",
    icon: GitPullRequest,
    run: noop
  },
  {
    id: "github-issues.refresh",
    kind: "plugin",
    label: "Refresh issues",
    detail: "GitHub Issues",
    group: "GitHub Issues",
    run: noop
  },
  {
    id: "github-issues.open",
    kind: "plugin",
    label: "Open issue in browser",
    detail: "GitHub Issues",
    group: "GitHub Issues",
    run: noop
  }
]

/** Open, unfiltered — every group at once. */
export const Default: Story = {
  args: { open: true, onOpenChange: noop, items: ITEMS }
}

/** Nothing but sessions, the state on a fresh install with no plugins. */
export const SessionsOnly: Story = {
  args: {
    open: true,
    onOpenChange: noop,
    items: ITEMS.filter((i) => i.kind === "session")
  }
}

/** No sessions at all — first launch, before anything has been created. */
export const NothingToShow: Story = {
  args: { open: true, onOpenChange: noop, items: [] }
}

/** Driven by a real toggle, so open/close and the query reset can be felt. */
export const Interactive: Story = {
  args: { open: false, onOpenChange: noop, items: ITEMS },
  render: (args) => {
    const [open, setOpen] = React.useState(false)
    return (
      <div className="flex h-[520px] items-start justify-center pt-8">
        <Button onClick={() => setOpen(true)}>Open the palette</Button>
        <CommandPalette {...args} open={open} onOpenChange={setOpen} />
      </div>
    )
  }
}
