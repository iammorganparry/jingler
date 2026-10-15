import type { Meta, StoryObj } from "@storybook/react-vite"
import { SignInDialog } from "./sign-in-dialog.js"

const meta = {
  title: "Composites/SignInDialog",
  component: SignInDialog,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onOpenChange: () => {},
    onGithub: () => {},
    onGoogle: () => {},
    onSendMagicLink: () => {},
    onCancel: () => {},
    onRetry: () => {},
    onReset: () => {},
    signInUrl: "https://jingler.dev/sign-in?code=demo"
  }
} satisfies Meta<typeof SignInDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Loading: Story = { args: { state: "loading" } }
export const Waiting: Story = { args: { state: "waiting" } }
export const Sent: Story = { args: { state: "sent", sentEmail: "morgan@example.com" } }
export const ErrorState: Story = {
  name: "Error",
  args: { state: "error", errorMessage: "We couldn't send the sign-in link. Please try again." }
}
