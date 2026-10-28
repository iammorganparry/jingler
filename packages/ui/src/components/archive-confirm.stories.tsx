import type { Meta, StoryObj } from "@storybook/react-vite"
import { ConfirmDialog } from "./confirm-dialog.js"

const meta = {
  title: "Components/ConfirmDialog/Archive",
  component: ConfirmDialog,
  args: { open: true, onOpenChange: () => {}, onConfirm: () => {}, closeOnConfirm: false }
} satisfies Meta<typeof ConfirmDialog>

export default meta
type Story = StoryObj<typeof meta>

/** Asked before every archive: terminal history is saved, the final button is the destructive "Archive". */
export const Confirm: Story = {
  args: { title: "Archive this workspace?", description: "Terminal history is saved", confirmLabel: "Archive", destructive: true }
}

/** A failed archive keeps the dialog open with the error; the confirm button becomes Retry. */
export const Failed: Story = {
  args: { title: "Archive failed", description: "Cleanup exited with code 7.", confirmLabel: "Retry", destructive: true }
}
