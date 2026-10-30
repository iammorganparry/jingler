import type { Meta, StoryObj } from "@storybook/react-vite"
import { RepoChip } from "./repo-chip.js"

const meta: Meta = { title: "Atoms/RepoChip" }
export default meta
type Story = StoryObj

/** Compare with Paper board "Workspace sidebar — flat list + repo chips" (02 · Improved, QNI-0). */
export const States: Story = {
  render: () => (
    <div className="flex flex-col gap-3 bg-panel p-6">
      <div className="flex gap-1">
        <RepoChip repo="acme/api" prNumber={482} pr={{ state: "open", checks: "pass" }} added={42} removed={7} />
        <RepoChip repo="acme/web" prNumber={91} pr={{ state: "open", checks: "fail" }} added={18} removed={3} />
      </div>
      <div className="flex gap-1">
        <RepoChip repo="api" added={9} removed={2} />
        <RepoChip repo="web" prNumber={88} pr={{ state: "merged", checks: null }} />
        <RepoChip repo="billing" missing />
      </div>
    </div>
  )
}
