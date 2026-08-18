import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import {
  LinkedIssueSelector,
  type LinkedIssueSelectorItem,
  type LinkedIssueSelectorProps
} from "./linked-issue-selector.js"

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
