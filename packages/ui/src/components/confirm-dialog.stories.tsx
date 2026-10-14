import type { Meta, StoryObj } from "@storybook/react-vite"
import { ConfirmDialog } from "./confirm-dialog.js"

const meta = {
  title: "Components/ConfirmDialog",
  component: ConfirmDialog,
  args: { open: true, onOpenChange: () => {}, onConfirm: () => {} }
} satisfies Meta<typeof ConfirmDialog>

export default meta
type Story = StoryObj<typeof meta>

/** Non-destructive: neutral primary confirm, no red fill. */
export const Default: Story = {
  args: { title: "Archive without cleanup?", description: "Files and running jobs are preserved.", confirmLabel: "Archive" }
}

/** Destructive: the confirm is the only solid red fill and Cancel takes initial focus. */
export const Destructive: Story = {
  args: {
    title: "Delete session?",
    description: "The session and its transcript are permanently removed.",
    confirmLabel: "Delete",
    destructive: true
  }
}
