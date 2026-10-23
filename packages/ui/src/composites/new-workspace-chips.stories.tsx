import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { userEvent, within } from "storybook/test"
import { FolderGit2, GitFork, GitPullRequest } from "lucide-react"
import { ChipMenu } from "../components/chip-menu.js"
import { ChipRow, FromChip, type FromSourceOption } from "./new-workspace-chips.js"
import type { NewSessionSource } from "./new-workspace-machine.js"

const SOURCES: ReadonlyArray<FromSourceOption> = [
  { value: "blank", label: "New task", description: "Start from a base branch", icon: null },
  { value: "pr", label: "Pull request", description: "Work on an open GitHub PR", icon: <GitPullRequest size={15} /> },
  { value: "github", label: "GitHub issue", description: "Link and prefill from GitHub", icon: null },
  { value: "provider:linear", label: "Linear issue", description: "Link and prefill from Linear", icon: null },
]
const CHECKOUTS = [
  { value: "worktree", label: "Worktree", description: "Isolated Git worktree for this session" },
  { value: "direct", label: "This checkout", description: "Work directly in the project checkout" },
] as const

function Row({ initial, isolation = "worktree", auto = false, open = false }: {
  initial: NewSessionSource; isolation?: "worktree" | "direct"; auto?: boolean; open?: boolean
}) {
  const [source, setSource] = useState<NewSessionSource>(initial)
  const [branch, setBranch] = useState("main")
  const [iso, setIso] = useState(isolation)
  return (
    <div className="flex min-h-[420px] items-end bg-panel p-6" data-open={open}>
      <ChipRow>
        <ChipMenu value="p" options={[{ value: "p", label: auto ? "Auto" : "jingler" }]} icon={<FolderGit2 size={12} />} ariaLabel="Project" />
        {!auto && <FromChip label={`from ${branch}`} source={source} branches={["main", "develop", "release/2.0"]} baseBranch={branch} sourceOptions={SOURCES} onSource={setSource} onBranch={setBranch} />}
        {!auto && <ChipMenu value={iso} options={CHECKOUTS} onSelect={setIso} icon={<GitFork size={12} />} ariaLabel="Checkout" />}
      </ChipRow>
    </div>
  )
}

const meta: Meta = { title: "Composites/New workspace chips", parameters: { layout: "fullscreen" } }
export default meta
type Story = StoryObj

const openFrom = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  await userEvent.click(within(canvasElement).getByRole("button", { name: "Start from" }))
}

export const FromBranch: Story = { render: () => <Row initial="blank" />, play: openFrom }
export const FromPullRequest: Story = { render: () => <Row initial="pr" />, play: openFrom }
export const FromIssue: Story = { render: () => <Row initial="github" />, play: openFrom }
export const WorktreeMenu: Story = {
  render: () => <Row initial="blank" />,
  play: async ({ canvasElement }) => { await userEvent.click(within(canvasElement).getByRole("button", { name: "Checkout" })) },
}
export const ThisCheckout: Story = { render: () => <Row initial="blank" isolation="direct" /> }
export const AutoNoRepo: Story = { render: () => <Row initial="blank" auto /> }
