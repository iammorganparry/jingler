import type { Meta, StoryObj } from "@storybook/react-vite"
import { NeedsYouCard, RunningRow } from "./home-cards.js"

const meta = { title: "Composites/Home cards", parameters: { layout: "padded" } } satisfies Meta
export default meta
type Story = StoryObj

const noop = () => {}

export const NeedsYouQuestion: Story = {
  render: () => <NeedsYouCard title="Migrate the store" text="Needs input" onAnswer={noop} onDismiss={noop} />
}
export const NeedsYouApproval: Story = {
  render: () => <NeedsYouCard title="Migrate the store" text="Needs approval" onAllow={noop} onAnswer={noop} onDismiss={noop} />
}
export const NoLongerWaiting: Story = {
  render: () => <NeedsYouCard title="Migrate the store" text="" stale onAnswer={noop} onDismiss={noop} />
}
export const Running: Story = { render: () => <RunningRow title="Fix flaky test" activity="Running npm test" onOpen={noop} /> }
