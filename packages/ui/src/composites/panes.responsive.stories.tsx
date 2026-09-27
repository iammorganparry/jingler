
import type { Meta, StoryObj } from "@storybook/react-vite"
import type { PullRequest as PullRequestData } from "@jingler/core"
import { LookFor, WidthLadder } from "../story-support.js"
import { PullRequestView } from "./pull-request-view.js"

const meta: Meta = { title: "Responsive/Panes", parameters: { layout: "fullscreen" } }
export default meta
type Story = StoryObj

const PR: PullRequestData = {
  number: 482,
  state: "open",
  title: "Add token store + refresh handling",
  body: "Adds a token store and refresh handling to the auth middleware.",
  url: "https://github.com/acme/x/pull/482",
  headRefName: "feat/oauth",
  baseRefName: "main",
  isDraft: false,
  author: { login: "claude-agent", avatarUrl: null },
  createdAt: "2026-07-21T08:00:00.000Z",
  commits: 6,
  changedFiles: 3,
  additions: 90,
  deletions: 3,
  labels: [
    { name: "auth", color: "c678dd" },
    { name: "needs-review", color: "e5c07b" }
  ],
  reviewers: [
    { login: "dan", state: "changes_requested" },
    { login: "you", state: "pending" }
  ],
  timeline: [
    {
      id: "r1",
      author: "dan",
      kind: "changes_requested",
      body: "The refresh guard should also handle the 401 retry path.",
      createdAt: "2026-07-21T09:00:00.000Z",
      path: "src/auth/session.ts",
      line: 34
    }
  ],
  reviewThreads: [],
  checks: [
    { name: "typecheck", status: "pass", url: null },
    { name: "test", status: "fail", url: null },
    { name: "build", status: "pending", url: null }
  ],
  mergeBlockers: [],
  mergeStateStatus: "CLEAN"
} as unknown as PullRequestData

/**
 * Pull Request: a 760px reading column beside a 352px rail.
 *
 * The rail was a hard `w-[352px] flex-none` with no resize handle at all. In a
 * 500px pane it left the PR body about 88px after its own 60px of gutter —
 * narrower than the PR title.
 */
export const PullRequestPane: Story = {
  render: () => (
    <div className="min-h-screen bg-canvas">
      <LookFor>
        <strong className="text-text-bright">Look for:</strong> the rail docked at 1240 and 720. At
        500 and 380 it is replaced by a floating toggle at the top-right — the rail holds the MERGE
        button, so it can never simply be dropped. Opening it should not reflow the timeline
        underneath.
      </LookFor>
      <WidthLadder
        height={420}
        render={() => <PullRequestView pr={PR} connected sessionTitle="Refactor auth flow" />}
      />
    </div>
  )
}

