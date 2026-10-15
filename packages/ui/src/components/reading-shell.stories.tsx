import type { Meta, StoryObj } from "@storybook/react-vite"
import { Badge } from "./badge.js"
import { Button } from "./button.js"
import { ReadingActionsMenu, ReadingShell } from "./reading-shell.js"

const meta: Meta = { title: "Molecules/ReadingShell" }
export default meta
type Story = StoryObj

const body = <p className="text-[13.5px] text-text-body">Body copy sits in the 720px reading column.</p>
const menu = (
  <ReadingActionsMenu
    items={[
      { label: "Copy link", onSelect: () => {} },
      { label: "Close issue", onSelect: () => {}, destructive: true }
    ]}
  />
)

/** Shared PR / issue header: title + grey identifier, meta line, actions; 280px rail when wide. */
export const WithRail: Story = {
  render: () => (
    <div className="flex h-[480px] w-[1100px] border border-line">
      <ReadingShell
        title="Refactor auth flow"
        identifier="#482"
        meta={<div className="flex items-center gap-2 text-[11.5px] text-muted-foreground"><Badge tone="green" size="sm">Open</Badge> octocat · 2h ago</div>}
        actions={<><Button size="sm">Start workspace</Button>{menu}</>}
        rail={<div className="text-xs text-muted-foreground">Rail</div>}
      >
        {body}
      </ReadingShell>
    </div>
  )
}

export const ColumnOnly: Story = {
  render: () => (
    <div className="flex h-[360px] w-[760px] border border-line">
      <ReadingShell title="Widget crashes" identifier="#1" actions={menu}>{body}</ReadingShell>
    </div>
  )
}
