import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import type { IssueActor, IssueDetail, IssueListItem } from "@jingler/core"
import { WidthTierValue } from "../hooks/width-tier.js"
import { IssueInbox, type IssueInboxProps } from "./issue-inbox.js"

const meta: Meta = { title: "GitHub/Issue Inbox", parameters: { layout: "fullscreen" } }
export default meta
type Story = StoryObj

const actor = (name: string): IssueActor => ({ id: name, name, avatarUrl: null })

const issue = (
  repository: string, number: number, title: string, fields: Partial<IssueListItem> = {}
): IssueListItem => ({
  providerId: "github",
  id: String(number),
  identifier: `#${number}`,
  number,
  repository,
  title,
  url: `https://github.com/${repository}/issues/${number}`,
  body: "",
  state: "open",
  labels: [],
  author: actor("morgan"),
  assignees: [],
  comments: 0,
  updatedAt: "2026-08-12T14:32:00.000Z",
  ...fields,
})

const ISSUES: ReadonlyArray<IssueListItem> = [
  issue("jingler/jingler", 734, "Issues view should remember the last repository filter", {
    labels: [{ name: "desktop", color: "1f6feb" }, { name: "ui", color: "a371f7" }],
    assignees: [actor("morgan")], comments: 4,
  }),
  issue("jingler/cloud", 211, "Webhook retries drop the installation id on the second attempt", {
    labels: [{ name: "bug", color: "d73a4a" }], author: actor("rachel"), comments: 9,
    updatedAt: "2026-08-12T11:05:00.000Z",
  }),
  issue("acme/mobile", 58, "Onboarding skips the permissions step on Android 15", {
    labels: [{ name: "mobile", color: "2da44e" }], author: actor("dan"),
    assignees: [actor("morgan"), actor("rachel")], updatedAt: "2026-08-11T16:40:00.000Z",
  }),
  issue("acme/api", 1402, "Document the rate-limit reset header", {
    author: actor("dan"), updatedAt: "2026-08-10T09:15:00.000Z",
  }),
  issue("jingler/jingler", 699, "A very long issue title that has to wrap across several lines in the narrow list column without breaking the row layout", {
    labels: [{ name: "needs-triage", color: null }, { name: "design", color: "fbca04" }, { name: "p2", color: "0e8a16" }],
    updatedAt: "2026-08-02T09:15:00.000Z",
  }),
]

const detailFor = (item: IssueListItem): IssueDetail => ({
  ...item,
  body: "## Problem\n\nSwitching away from the Issues view and back resets the **Repository** filter.\n\n## Expected\n\n- The filter survives navigation\n- `Clear filters` still resets it\n\n```ts\nsendFilters({ type: \"CHANGE\", fields: { repository } })\n```",
  createdAt: "2026-08-09T09:00:00.000Z",
  comments: [
    { id: "c1", author: actor("rachel"), body: "Reproduced on main. Happens on every view switch.", createdAt: "2026-08-10T10:00:00.000Z" },
    { id: "c2", author: actor("morgan"), body: "Probably the filter machine remounting. I'll take it.", createdAt: "2026-08-12T13:10:00.000Z" },
  ],
})

function InboxMock({ width, ...overrides }: { width: number } & Partial<IssueInboxProps>) {
  const [selected, setSelected] = useState(ISSUES[0]!)
  return (
    <WidthTierValue width={width}>
      <div className="flex h-screen w-full bg-editor">
        <IssueInbox
          issues={ISSUES}
          viewerLogin="morgan"
          selected={{ repository: selected.repository, number: selected.number }}
          detail={detailFor(selected)}
          onSelect={setSelected}
          onOpenOnGithub={() => {}}
          onComment={async () => {}}
          onCloseIssue={async () => {}}
          sessionAction={{ label: "Start session", onSelect: () => {} }}
          {...overrides}
        />
      </div>
    </WidthTierValue>
  )
}

export const Desktop: Story = { render: () => <InboxMock width={1440} /> }

export const SmallScreen: Story = {
  parameters: { viewport: { defaultViewport: "mobile2" } },
  render: () => <InboxMock width={480} />,
}

const GITHUB_MARKDOWN = [
  "## Every GitHub feature",
  "Thanks @rachel — fixes #12, relates to acme/api#9, landed in a5c3785ed8d6a35868bc169f07e40e889087fd2e :tada:",
  "Single newline\nbecomes a line break, like on GitHub.",
  "> [!NOTE]\n> Useful information.\n\n> [!TIP]\n> A helpful hint.\n\n> [!IMPORTANT]\n> Key information.\n\n> [!WARNING]\n> Needs attention.\n\n> [!CAUTION]\n> Risky outcome.",
  "- [x] task done\n- [ ] task todo\n\n~~struck~~ **bold** *italic* `code` <kbd>⌘</kbd>+<kbd>K</kbd> H<sub>2</sub>O x<sup>2</sup>",
  "| Feature | Status |\n|---|---|\n| Tables | ✅ |\n| Alerts | ✅ |",
  "```python\ndef hello(name: str) -> str:\n    return f\"hi {name}\"\n```\n\n```rust\nfn main() { println!(\"hi\"); }\n```\n\n```diff\n- old\n+ new\n```",
  "<details><summary>Collapsed section</summary>\n\nHidden body.\n\n</details>",
  "Math: $e^{i\\pi} + 1 = 0$ and a footnote[^1]. Jump to [the top](#every-github-feature).\n\n[^1]: The footnote text.",
].join("\n\n")

export const GitHubMarkdown: Story = {
  render: () => <InboxMock width={1440} detail={{ ...detailFor(ISSUES[0]!), body: GITHUB_MARKDOWN, comments: [] }} />,
}

export const NoLocalProject: Story = {
  render: () => <InboxMock width={1440} sessionAction={{
    label: "Start session", onSelect: () => {}, disabledReason: "Add jingler/jingler as a project to start a session.",
  }} />,
}

export const CloseFailed: Story = {
  render: () => <InboxMock width={1440} closeError="Resource not accessible by integration (HTTP 403)." />,
}

export const DetailLoading: Story = {
  render: () => <InboxMock width={1440} detail={null} detailLoading />,
}

export const DetailError: Story = {
  render: () => <InboxMock width={1440} detail={null} detailError="Could not load issue #734." />,
}

export const NothingSelected: Story = {
  render: () => <InboxMock width={1440} selected={null} detail={null} />,
}

export const Loading: Story = {
  render: () => <InboxMock width={1440} issues={[]} selected={null} detail={null} loading />,
}

export const Empty: Story = {
  render: () => <InboxMock width={1440} issues={[]} selected={null} detail={null} />,
}

export const ListError: Story = {
  render: () => <InboxMock width={1440} issues={[]} selected={null} detail={null} error="GitHub CLI is not authenticated. Run gh auth login, then refresh." />,
}
