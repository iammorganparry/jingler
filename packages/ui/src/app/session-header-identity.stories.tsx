import type { Meta, StoryObj } from "@storybook/react-vite"
import { CircleDot, GitPullRequest } from "lucide-react"
import { fn } from "storybook/test"
import { SessionHeaderIdentity } from "./session-header-identity.js"

const meta = {
  title: "App/SessionHeaderIdentity",
  component: SessionHeaderIdentity,
  parameters: { layout: "centered" }
} satisfies Meta<typeof SessionHeaderIdentity>

export default meta
type Story = StoryObj<typeof meta>

/** Board 04b header (301-0): title, filled branch chip, outlined PR and issue chips. */
export const Default: Story = {
  args: {
    title: "Fix PR inbox pagination",
    branch: "morgan/pr-inbox-pagination",
    chips: [
      { id: "pr", label: "PR #482", title: "Open pull request", icon: GitPullRequest, onOpen: fn() },
      { id: "issue", label: "LIN-482", title: "Open LIN-482", icon: CircleDot, onOpen: fn() }
    ]
  }
}

/** Missing branch / PR / issue render nothing. */
export const TitleOnly: Story = { args: { title: "Fix PR inbox pagination", chips: [] } }
