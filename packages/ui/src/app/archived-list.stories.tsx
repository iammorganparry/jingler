import type { Meta, StoryObj } from "@storybook/react-vite"
import { ConfirmDialog } from "../components/confirm-dialog.js"
import { testSession } from "../test-support.js"
import { ArchivedList } from "./archived-list.js"

const SESSIONS = [
  testSession({ id: "a1", title: "Refactor auth flow", repo: "jingler", archived: true, archivedAt: "2026-07-09T10:00:00.000Z" }),
  testSession({ id: "a2", title: "Fix token refresh", repo: "jingler", archived: true, archivedAt: "2026-07-01T10:00:00.000Z" }),
  testSession({ id: "a3", title: "Billing webhook retries", repo: "gtm-grid", archived: true, archivedAt: "2026-06-20T10:00:00.000Z" })
]

const meta = {
  title: "App/ArchivedList",
  component: ArchivedList,
  parameters: { layout: "fullscreen" },
  args: { open: true, onOpenChange: () => {}, sessions: SESSIONS, onRestore: () => {}, onDelete: () => {} }
} satisfies Meta<typeof ArchivedList>

export default meta
type Story = StoryObj<typeof meta>

/** "Archived (3)" opened from the sidebar: search plus Restore and Delete per row. */
export const Default: Story = {}

export const Empty: Story = { args: { sessions: [] } }

/** Delete never acts directly: the caller confirms with a destructive ConfirmDialog. */
export const DeleteConfirm: Story = {
  render: (args) => (
    <>
      <ArchivedList {...args} />
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete session?"
        description="“Refactor auth flow” and its isolated worktree will be permanently removed. This can't be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {}}
      />
    </>
  )
}
