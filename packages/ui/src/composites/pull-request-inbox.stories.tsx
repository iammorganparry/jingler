import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import type { PullRequest, PullRequestListItem } from "@jingler/core"
import { WidthTierValue } from "../hooks/width-tier.js"
import { PullRequestInbox } from "./pull-request-inbox.js"

const meta: Meta = { title: "GitHub/Pull Request Inbox", parameters: { layout: "fullscreen" } }
export default meta
type Story = StoryObj

const PRS: ReadonlyArray<PullRequestListItem> = [
  {
    repository: "jingler/jingler",
    number: 612,
    title: "Add pull request inbox and responsive detail view",
    headRefName: "feat/pr-inbox",
    baseRefName: "main",
    author: { login: "morgan", avatarUrl: null },
    state: "open",
    isDraft: false,
    additions: 284,
    deletions: 31,
    updatedAt: "2026-08-12T14:32:00.000Z",
    labels: [{ name: "desktop", color: "1f6feb" }, { name: "ui", color: "a371f7" }],
    comments: 6,
    assignedToViewer: false,
    reviewRequestedFromViewer: false
  },
  {
    repository: "jingler/cloud",
    number: 184,
    title: "Keep installation grants scoped to one repository",
    headRefName: "fix/grant-scope",
    baseRefName: "main",
    author: { login: "rachel", avatarUrl: null },
    state: "open",
    isDraft: false,
    additions: 48,
    deletions: 22,
    updatedAt: "2026-08-12T11:05:00.000Z",
    labels: [{ name: "security", color: "d73a4a" }],
    comments: 3,
    assignedToViewer: false,
    reviewRequestedFromViewer: true
  },
  {
    repository: "acme/mobile",
    number: 91,
    title: "Replace legacy onboarding state machine",
    headRefName: "onboarding-v2",
    baseRefName: "develop",
    author: { login: "morgan", avatarUrl: null },
    state: "draft",
    isDraft: true,
    additions: 631,
    deletions: 419,
    updatedAt: "2026-08-11T16:40:00.000Z",
    labels: [{ name: "mobile", color: "2da44e" }],
    comments: 0,
    assignedToViewer: true,
    reviewRequestedFromViewer: false
  },
  {
    repository: "acme/api",
    number: 1337,
    title: "Return rate-limit reset metadata from provider calls",
    headRefName: "rate-limit-metadata",
    baseRefName: "main",
    author: { login: "dan", avatarUrl: null },
    state: "open",
    isDraft: false,
    additions: 92,
    deletions: 14,
    updatedAt: "2026-08-10T09:15:00.000Z",
    labels: [],
    comments: 12,
    assignedToViewer: true,
    reviewRequestedFromViewer: true
  }
]

const detailFor = (item: PullRequestListItem): PullRequest => ({
  number: item.number,
  state: item.state,
  title: item.title,
  body: "## What changed\n\nAdds a global pull request inbox with GitHub-style filtering and keeps the existing review view for detail. The list collapses away on smaller windows so the pull request remains readable.",
  url: `https://github.com/${item.repository}/pull/${item.number}`,
  headRefName: item.headRefName,
  baseRefName: item.baseRefName,
  isDraft: item.isDraft,
  author: item.author,
  createdAt: "2026-08-09T09:00:00.000Z",
  commits: 2,
  commitItems: [
    { sha: "c8e0c69a1", message: "fix: keep the latest CI result", author: item.author.login, committedAt: "2026-08-12T13:10:00.000Z", url: `https://github.com/${item.repository}/commit/c8e0c69a1`, verified: true },
    { sha: "0eaa191b2", message: "test: cover repeated check names", author: item.author.login, committedAt: "2026-08-12T12:40:00.000Z", url: `https://github.com/${item.repository}/commit/0eaa191b2`, verified: true }
  ],
  changedFiles: 9,
  additions: item.additions,
  deletions: item.deletions,
  labels: item.labels,
  reviewers: [{ login: "rachel", state: "approved" }, { login: "dan", state: "pending" }],
  timeline: [{ id: "review-1", author: "rachel", kind: "approved", body: "The responsive behavior looks right. One small naming note inline.", createdAt: "2026-08-12T12:00:00.000Z", path: null, line: null }],
  reviewThreads: [],
  checks: [{ name: "typecheck", status: "pass", detailsUrl: null, durationMs: 43000 }, { name: "tests", status: "pass", detailsUrl: null, durationMs: 71000 }],
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  mergeBlockers: []
})

function InboxMock({ width }: { width: number }) {
  const [selected, setSelected] = useState(PRS[0]!)
  return (
    <WidthTierValue width={width}>
      <div className="flex h-screen w-full bg-editor">
        <PullRequestInbox
          prs={PRS}
          viewerLogin="morgan"
          selected={{ repository: selected.repository, number: selected.number }}
          detail={detailFor(selected)}
          onSelect={setSelected}
          onOpenOnGithub={() => {}}
        />
      </div>
    </WidthTierValue>
  )
}

export const Desktop: Story = { render: () => <InboxMock width={1440} /> }

export const SmallScreen: Story = {
  parameters: { viewport: { defaultViewport: "mobile2" } },
  render: () => <InboxMock width={480} />
}

export const Loading: Story = {
  render: () => (
    <WidthTierValue width={1440}>
      <div className="flex h-screen"><PullRequestInbox prs={[]} viewerLogin="morgan" selected={null} detail={null} onSelect={() => {}} loading /></div>
    </WidthTierValue>
  )
}
