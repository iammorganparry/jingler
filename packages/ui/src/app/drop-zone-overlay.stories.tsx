import type { Meta, StoryObj } from "@storybook/react-vite"
import { DropZoneOverlay } from "./drop-zone-overlay.js"
import type { DropEdge } from "./editor-layout.js"

const meta: Meta = { title: "App/DropZoneOverlay", parameters: { layout: "centered" } }
export default meta
type Story = StoryObj

const Group = ({ edge, rejected }: { edge: DropEdge; rejected?: boolean }) => (
  <div className="relative h-[320px] w-[480px] bg-editor text-[12px] text-muted-foreground">
    <div className="p-4">Editor group</div>
    <DropZoneOverlay edge={edge} rejected={rejected} />
  </div>
)

/** Board 04k: a tab mid-drag over the right group, "Split right" hovered. */
export const SplitRight: Story = { render: () => <Group edge="right" /> }
export const SplitDown: Story = { render: () => <Group edge="bottom" /> }
export const MoveHere: Story = { render: () => <Group edge="center" /> }
/** A file can't be dropped into the chat pane's middle. */
export const Rejected: Story = { render: () => <Group edge="center" rejected /> }
