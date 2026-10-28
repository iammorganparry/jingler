import type { Meta, StoryObj } from "@storybook/react-vite"
import { FileQuickOpen } from "./file-quick-open.js"

/** ⌘P file picker: the same 640px palette surface, without the Workspace · Chat scope switch. */
const meta = {
  title: "Asset/FileQuickOpen",
  component: FileQuickOpen
} satisfies Meta<typeof FileQuickOpen>

export default meta
type Story = StoryObj<typeof meta>

const noop = () => {}

const entries = [
  { path: "src/file-browser-machine.ts", status: "modified" as const },
  { path: "docs/file-browser-notes.md", status: "clean" as const },
  { path: "packages/ui/src/button.tsx", status: "clean" as const }
]

export const Default: Story = {
  args: { open: true, onOpenChange: noop, onOpenPath: noop, entries, sessionTitle: "File browser" }
}

export const Loading: Story = {
  args: { open: true, onOpenChange: noop, onOpenPath: noop, entries: [], loading: true }
}

export const NoMatches: Story = {
  args: { open: true, onOpenChange: noop, onOpenPath: noop, entries: [] }
}
