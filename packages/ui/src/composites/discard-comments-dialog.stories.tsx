import type { Meta, StoryObj } from "@storybook/react-vite"
import { DiscardCommentsDialog } from "./discard-comments-dialog.js"

const meta = {
  title: "Composites/DiscardCommentsDialog",
  component: DiscardCommentsDialog,
  args: { open: true, count: 1, onOpenChange: () => {}, onDiscard: () => {} }
} satisfies Meta<typeof DiscardCommentsDialog>

export default meta
type Story = StoryObj<typeof meta>

export const OneComment: Story = {}

export const SeveralComments: Story = { args: { count: 3 } }
