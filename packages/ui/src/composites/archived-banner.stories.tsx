import type { Meta, StoryObj } from "@storybook/react-vite"
import { ArchivedBanner } from "./archived-banner.js"
import { BranchDriftBanner } from "./branch-drift-banner.js"
import { PrEventCard } from "./pr-event-card.js"
import { UnreachableBanner } from "./unreachable-banner.js"
import { DeviceOfflineBanner, OfflineBanner, RelayQuotaBanner } from "./connectivity-banners.js"

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

export const PrOpenedStacked: Story = {
  render: () => <PrEventCard event={{ _tag: "PrEvent", kind: "opened", number: 482, stackedOn: 481 }} />
}

export const PrOpened: Story = {
  render: () => <PrEventCard event={{ _tag: "PrEvent", kind: "opened", number: 481 }} />
}

export const PrMerged: Story = {
  render: () => <PrEventCard event={{ _tag: "PrEvent", kind: "merged", number: 482 }} />
}

export const Unreachable: Story = {
  render: () => <UnreachableBanner onRetry={noop} />
}

export const Offline: Story = {
  render: () => <OfflineBanner />
}

export const DeviceOffline: Story = {
  render: () => <DeviceOfflineBanner device="Studio-Mac" onContinueLocally={noop} />
}

export const RelayQuotaReached: Story = {
  render: () => <RelayQuotaBanner resetsOn="Nov 1" onDismiss={noop} />
}
