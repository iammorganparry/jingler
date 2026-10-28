import type { Meta, StoryObj } from "@storybook/react-vite"
import { ImportCard } from "./import-card.js"

const meta = { title: "Composites/Import card", parameters: { layout: "padded" } } satisfies Meta
export default meta
type Story = StoryObj

const noop = () => {}

export const Detecting: Story = { render: () => <ImportCard state={{ kind: "detecting" }} onReview={noop} onRetry={noop} onDismiss={noop} /> }
export const Found: Story = { render: () => <ImportCard state={{ kind: "found", count: 3 }} onReview={noop} onRetry={noop} onDismiss={noop} /> }
export const Failed: Story = { render: () => <ImportCard state={{ kind: "failed", message: "Could not detect MCP servers" }} onReview={noop} onRetry={noop} onDismiss={noop} /> }
// Dismissed renders nothing: deriveImportCard returns null and the host omits the card.
export const Dismissed: Story = { render: () => <p className="text-[12px] text-dim">Dismissed: nothing is rendered.</p> }
