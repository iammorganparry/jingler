import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { userEvent, within } from "storybook/test"
import { LinearMark } from "../components/linear-mark.js"
import type { TabContribution } from "../app/tab-contributions.js"
import type { ViewRailMenu } from "../app/view-rail.js"
import { testSession } from "../test-support.js"
import { SessionPane } from "./session-pane.js"

const LINEAR_TAB_ID = "linear.issue"
const LINEAR_MENU_LABEL = "Select linked Linear issue"
const issues = [
  { id: "issue-124", identifier: "ENG-124", title: "Document retry policy" },
  { id: "issue-125", identifier: "ENG-125", title: "Reconcile duplicate charges" },
  { id: "issue-126", identifier: "ENG-126", title: "Add audit events to settlement retries" }
] as const

const meta = {
  title: "Screens/SessionPane",
  parameters: { layout: "fullscreen" }
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

function LinearIssueRailPreview() {
  const [selected, setSelected] = useState<string>(issues[0]!.id)
  const selectedIssue = issues.find((issue) => issue.id === selected) ?? issues[0]!
  const contribution: TabContribution = {
    id: LINEAR_TAB_ID,
    label: "Linear",
    icon: LinearMark,
    order: 10,
    when: () => true,
    render: () => (
      <div className="flex flex-1 flex-col bg-editor p-8 text-text">
        <div className="text-xs font-medium text-purple">{selectedIssue.identifier}</div>
        <h1 className="mt-1 text-xl font-semibold text-text-bright">{selectedIssue.title}</h1>
        <p className="mt-4 max-w-xl text-sm text-dim">
          The selected issue detail, metadata, and comments render here.
        </p>
      </div>
    )
  }
  const menu: ViewRailMenu = {
    value: selected,
    ariaLabel: LINEAR_MENU_LABEL,
    onSelect: setSelected,
    options: issues.map((issue) => ({
      value: issue.id,
      label: issue.identifier,
      description: issue.title,
      ariaLabel: `${issue.identifier} ${issue.title}`,
      searchText: `${issue.identifier} ${issue.title}`
    }))
  }
  const session = testSession({
    id: "linear-right-rail",
    repo: "jingler",
    title: "Reconcile duplicate charges",
    linkedIssues: issues.map((issue) => ({
      providerId: "linear",
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: `https://linear.app/acme/issue/${issue.identifier}`,
      labels: []
    })),
    selectedIssue: { providerId: "linear", id: selected }
  })
  return (
    <div className="h-screen min-h-[620px] bg-app">
      <SessionPane
        session={session}
        renderConversation={() => (
          <div className="flex flex-1 items-center justify-center bg-editor text-sm text-dim">
            Conversation remains visible until an issue is selected.
          </div>
        )}
        tabContributions={[contribution]}
        viewRailMenus={{ [LINEAR_TAB_ID]: menu }}
      />
    </div>
  )
}

/** The real right-edge view rail with the Linear multi-issue flyout opened. */
export const LinearIssueFlyout: Story = {
  render: () => <LinearIssueRailPreview />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: LINEAR_MENU_LABEL }))
  }
}
