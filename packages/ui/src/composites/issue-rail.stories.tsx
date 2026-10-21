import type { Meta, StoryObj } from "@storybook/react-vite"
import { ClosedIssueBanner, IssueRail, IssueStateView } from "./issue-rail.js"

const meta: Meta = { title: "Composites/IssueRail" }
export default meta
type Story = StoryObj

const frame = (node: React.ReactNode) => <div className="flex h-[320px] w-[720px] border border-line">{node}</div>

export const Full: Story = {
  render: () => (
    <div className="w-[280px]">
      <IssueRail
        assignees={[{ login: "octocat" }]}
        labels={[{ name: "bug", color: "ff0000" }, { name: "good first issue" }]}
        pullRequests={[{ number: 741, state: "open", url: "https://github.com/acme/widget/pull/741" }]}
        workspace={{ title: "Fix widget crash", onOpen: () => {} }}
        provider="GitHub"
        repository="acme/widget"
      />
    </div>
  )
}
export const EmptySectionsHidden: Story = {
  render: () => <div className="w-[280px]"><IssueRail provider="GitHub" repository="acme/widget" /></div>
}
export const Loading: Story = { render: () => frame(<IssueStateView state={{ kind: "loading" }} />) }
export const NotLinked: Story = { render: () => frame(<IssueStateView state={{ kind: "unlinked", onLink: () => {} }} />) }
export const LoadError: Story = {
  render: () => frame(<IssueStateView state={{ kind: "error", reason: "gh: HTTP 404 Not Found", onRetry: () => {} }} />)
}
export const Closed: Story = { render: () => <div className="w-[720px]"><ClosedIssueBanner onReopen={() => {}} /></div> }
export const Reopening: Story = { render: () => <div className="w-[720px]"><ClosedIssueBanner reopening onReopen={() => {}} /></div> }
