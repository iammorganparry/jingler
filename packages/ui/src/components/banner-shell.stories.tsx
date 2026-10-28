import type { Meta, StoryObj } from "@storybook/react-vite"
import { Archive, GitBranch, TriangleAlert } from "lucide-react"
import { BannerShell } from "./banner-shell.js"
import { Button } from "./button.js"

const meta: Meta = { title: "Molecules/BannerShell" }
export default meta
type Story = StoryObj

/** Placements: top hairline, lane header, inline card; red only on failure (boards 23, 12). */
export const Placements: Story = {
  render: () => (
    <div className="flex w-[560px] flex-col gap-4 bg-panel p-4">
      <BannerShell placement="top" icon={<GitBranch size={13} />} onDismiss={() => {}}>Checkout moved off feat/review-retry</BannerShell>
      <BannerShell placement="lane" icon={<Archive size={13} />}
        actions={[<Button key="r" variant="secondary" size="sm">Restore</Button>, <Button key="d" variant="danger" size="sm">Delete</Button>]}>
        Archived after PR #491 merged into main
      </BannerShell>
      <BannerShell placement="card" failed icon={<TriangleAlert size={13} />}
        actions={[<Button key="t" variant="secondary" size="sm">Retry</Button>]}>
        Runtime recovery failed: the last tool call can't be replayed
      </BannerShell>
    </div>
  )
}
