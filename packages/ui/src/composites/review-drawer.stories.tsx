import { useEffect } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import type { PullRequest } from "@jingler/core"
import { ReviewDrawer, useReviewDrawer } from "./review-drawer.js"
import type { ReviewFindingDraft } from "./review-drawer-machine.js"

const meta: Meta = { title: "GitHub/Review Drawer", parameters: { layout: "fullscreen" } }
export default meta
type Story = StoryObj

const PR: PullRequest = {
  number: 443, state: "open", title: "Add the PR Files and Checks sub-tabs", body: "",
  url: "https://github.com/acme/widget/pull/443", headRefName: "feat/tabs", baseRefName: "main", isDraft: false,
  author: { login: "morgan", avatarUrl: null }, createdAt: "2026-08-26T08:00:00Z", commits: 1, commitItems: [],
  changedFiles: 12, additions: 10, deletions: 2, labels: [], reviewers: [], timeline: [], reviewThreads: [],
  checks: [{ name: "Typecheck", status: "pass", detailsUrl: null, durationMs: 1 }, { name: "Lint", status: "fail", detailsUrl: null, durationMs: 1 }],
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", mergeBlockers: []
}

const DRAFTS: ReadonlyArray<ReviewFindingDraft> = [
  { id: "a", severity: "issue", path: "src/auth.ts", line: 42, body: "Token is read before the null check." },
  { id: "b", severity: "nit", path: "src/auth.ts", line: 57, body: "Prefer a named constant over 3600." }
]

function Open({ drafts }: { drafts: ReadonlyArray<ReviewFindingDraft> }) {
  const drawer = useReviewDrawer(drafts)
  useEffect(() => drawer.send({ type: "OPEN" }), [drawer.send])
  return <div className="flex h-screen justify-end"><ReviewDrawer pr={PR} drawer={drawer} /></div>
}

/** Drawer open with no findings yet. */
export const Empty: Story = { render: () => <Open drafts={[]} /> }

/** Drawer open with an Issue and a Nit awaiting a decision. */
export const Drafts: Story = { render: () => <Open drafts={DRAFTS} /> }

/** Drawer open at the ⅓ width of a 1440px window. */
export const Open1440: Story = {
  render: () => <div style={{ width: 1440 }}><Open drafts={DRAFTS} /></div>
}
