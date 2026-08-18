import type { Meta, StoryObj } from "@storybook/react-vite"
import type { IssueIdentity, Session } from "@jingler/core"
import { useState } from "react"
import { userEvent, within } from "storybook/test"
import { LinearMark } from "../components/linear-mark.js"
import { SessionRow } from "./session-row.js"
import {
  LinkedIssueSelector,
  type LinkedIssueSelectorItem,
  type LinkedIssueSelectorProps
} from "./linked-issue-selector.js"

const LINEAR_ISSUE_TRIGGER = /Select linked Linear issue/

const issues: ReadonlyArray<LinkedIssueSelectorItem> = [
  { value: "issue-124", identifier: "ENG-124", title: "Document retry policy" },
  { value: "issue-125", identifier: "ENG-125", title: "Reconcile duplicate charges" },
  { value: "issue-126", identifier: "ENG-126", title: "Add audit events to settlement retries" }
]

function ControlledSelector(props: LinkedIssueSelectorProps) {
  const [value, setValue] = useState(props.value)
  return <LinkedIssueSelector {...props} value={value} onValueChange={setValue} />
}

const meta = {
  title: "Composites/LinkedIssueSelector",
  component: LinkedIssueSelector,
  parameters: { layout: "centered" },
  args: { icon: <LinearMark className="size-3.5 text-purple" /> },
  render: (args) => <ControlledSelector {...args} />
} satisfies Meta<typeof LinkedIssueSelector>

export default meta
type Story = StoryObj<typeof meta>

export const Narrow: Story = {
  decorators: [(Story) => <div className="w-[176px]"><Story /></div>],
  args: { items: issues, value: "issue-124", variant: "compact" }
}

export const Wide: Story = {
  decorators: [(Story) => <div className="w-[420px]"><Story /></div>],
  args: { items: issues, value: "issue-124", variant: "full" }
}

export const OneIssue: Story = {
  decorators: [(Story) => <div className="w-[320px]"><Story /></div>],
  args: { items: [issues[0]!], value: "issue-124" }
}

export const ManyIssues: Story = {
  decorators: [(Story) => <div className="w-[360px]"><Story /></div>],
  args: {
    items: Array.from({ length: 8 }, (_, index) => ({
      value: `issue-${index + 200}`,
      identifier: `ENG-${index + 200}`,
      title: [
        "Improve reconciliation telemetry",
        "Preserve task context across retries",
        "Make settlement imports idempotent"
      ][index % 3]!
    })),
    value: "issue-200"
  }
}

export const LongTitle: Story = {
  decorators: [(Story) => <div className="w-[280px]"><Story /></div>],
  args: {
    items: [
      {
        value: "long-1",
        identifier: "PLATFORM-982",
        title: "Preserve the complete settlement audit trail while reconciling duplicate payment provider callbacks"
      },
      issues[0]!
    ],
    value: "long-1"
  }
}

export const Selected: Story = {
  decorators: [(Story) => <div className="w-[360px]"><Story /></div>],
  args: { items: issues, value: "issue-125" }
}

const sidebarSession = (selectedIssue: IssueIdentity): Session => ({
  id: "linear-sidebar",
  repo: "jingler",
  branch: "feat/reconcile-duplicate-charges",
  title: "Reconcile duplicate charges",
  status: "idle",
  diff: { added: 42, removed: 8 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-08-18T16:42:00.000Z",
  chats: [{
    id: "c_linear-sidebar_1",
    title: null,
    createdAt: "2026-08-18T16:42:00.000Z",
    updatedAt: "2026-08-18T16:42:00.000Z"
  }],
  activeChatId: "c_linear-sidebar_1",
  archived: false,
  linkedIssues: issues.map((issue) => ({
    providerId: "linear",
    id: issue.value,
    identifier: issue.identifier,
    title: issue.title,
    url: `https://linear.app/acme/issue/${issue.identifier}`,
    labels: []
  })),
  selectedIssue
})

function SidebarItemPreview() {
  const [selectedIssue, setSelectedIssue] = useState<IssueIdentity>({
    providerId: "linear",
    id: issues[0]!.value
  })
  return (
    <div className="w-[312px] rounded-xl border border-line bg-panel p-2 shadow-xl">
      <SessionRow
        session={sidebarSession(selectedIssue)}
        active
        slotIndex={0}
        onSelect={() => undefined}
        onIssueSelect={(_sessionId, issue) => setSelectedIssue(issue)}
      />
    </div>
  )
}

/** The real sidebar row with the multi-Linear-issue flyout opened for review. */
export const SidebarSessionItem: Story = {
  parameters: { layout: "centered" },
  args: { items: issues, value: issues[0]!.value },
  render: () => <SidebarItemPreview />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: LINEAR_ISSUE_TRIGGER }))
  }
}
