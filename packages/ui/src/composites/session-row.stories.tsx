import type { Meta, StoryObj } from "@storybook/react-vite"
import { testSession } from "../test-support.js"
import { SessionRow } from "./session-row.js"

const meta: Meta = { title: "Sidebar/Session Row", parameters: { layout: "centered" } }
export default meta
type Story = StoryObj

/** A run cut off by a restart reads "Interrupted" until the session goes live again. */
export const Interrupted: Story = {
  render: () => (
    <div className="w-[248px]">
      <SessionRow session={testSession({ id: "interrupted", title: "Refactor auth middleware" })} interrupted />
    </div>
  )
}

/** 248px is the sidebar width: status, PR number and diff stat stay on one line; only the branch truncates. */
export const LongBranchAtSidebarWidth: Story = {
  render: () => (
    <div className="w-[248px]">
      <SessionRow
        session={testSession({
          id: "long-branch",
          title: "Fix PR inbox pagination",
          branch: "feat/a-very-long-branch-name-that-must-truncate-instead-of-pushing-the-row-wide",
          prNumber: 482,
          diff: { added: 1204, removed: 311 }
        })}
      />
    </div>
  )
}

/** An Auto session before the agent attaches a repo reads "No repo" in place of the repo name. */
export const NoRepo: Story = {
  render: () => (
    <div className="w-[248px]">
      <SessionRow session={testSession({ id: "auto", title: "Cross-repo audit", repo: "", branch: "", checkouts: [] })} />
    </div>
  )
}
