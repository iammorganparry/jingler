import type { Meta, StoryObj } from "@storybook/react-vite"
import { ArchivedBanner } from "./archived-banner.js"
import { BranchDriftBanner } from "./branch-drift-banner.js"
import { UnreachableBanner } from "./unreachable-banner.js"

const meta = { title: "Composites/Banners", parameters: { layout: "padded" } } satisfies Meta
export default meta
type Story = StoryObj

const noop = () => {}

export const ArchivedMerged: Story = {
  render: () => <ArchivedBanner reason="merged" prNumber={482} base="main" onRestore={noop} onDelete={noop} />
}

export const ArchivedClosed: Story = {
  render: () => <ArchivedBanner reason="closed" prNumber={482} base="main" onRestore={noop} onDelete={noop} />
}

export const BranchDrift: Story = {
  render: () => <BranchDriftBanner pinnedBranch="feat/review-retry" liveBranch="fix/other" onFork={noop} onAdopt={noop} />
}

export const BranchDriftDetachedHead: Story = {
  render: () => <BranchDriftBanner pinnedBranch="main" liveBranch={null} onFork={noop} />
}

export const Unreachable: Story = {
  render: () => <UnreachableBanner onRetry={noop} />
}
