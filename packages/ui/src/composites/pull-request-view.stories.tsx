import type { Meta, StoryObj } from "@storybook/react-vite"
import type { PullRequest } from "@jingler/core"
import { WidthTierValue } from "../hooks/width-tier.js"
import { PullRequestView } from "./pull-request-view.js"

const meta: Meta = { title: "GitHub/Pull Request View", parameters: { layout: "fullscreen" } }
export default meta
type Story = StoryObj

const PR: PullRequest = {
  number: 443, state: "open", title: "Add the PR Files and Checks sub-tabs", body: "Files and Checks.",
  url: "https://github.com/acme/widget/pull/443", headRefName: "feat/tabs", baseRefName: "main", isDraft: false,
  author: { login: "morgan", avatarUrl: null }, createdAt: "2026-08-26T08:00:00Z", commits: 1, commitItems: [],
  changedFiles: 2, additions: 10, deletions: 2, labels: [], reviewers: [], timeline: [], reviewThreads: [],
  checks: [
    { name: "Typecheck", status: "pass", detailsUrl: "https://ci.example/1", durationMs: 72000 },
    { name: "Lint", status: "fail", detailsUrl: "https://ci.example/2", durationMs: 48000 },
    { name: "E2E", status: "running", detailsUrl: null, durationMs: null },
    { name: "Deploy", status: "pending", detailsUrl: null, durationMs: null }
  ],
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", mergeBlockers: []
}

/** Open the Checks tab to see the failing-check state (red icon only). */
export const Checks: Story = {
  render: () => <WidthTierValue width={1200}><PullRequestView pr={PR} connected /></WidthTierValue>
}

/** Open the Files tab to see the PR's own files panel, read-only. */
export const Files: Story = {
  render: () => (
    <WidthTierValue width={1200}>
      <PullRequestView pr={PR} connected filesPanel={<div className="rounded-lg border border-line bg-panel p-4 text-[13px] text-text">src/a.ts · src/b.ts</div>} />
    </WidthTierValue>
  )
}

/** Conversation with no description, on the viewer's own PR: Approve / Request changes disabled. */
export const ConversationOwnPrNoDescription: Story = {
  render: () => (
    <WidthTierValue width={1200}>
      <PullRequestView pr={{ ...PR, body: null }} connected viewerLogin="morgan" onSubmitReview={() => {}} />
    </WidthTierValue>
  )
}
