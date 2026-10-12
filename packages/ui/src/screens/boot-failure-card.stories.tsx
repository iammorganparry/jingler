import type { Meta, StoryObj } from "@storybook/react-vite"
import { BootFailureCard } from "./boot-failure-card.js"

const meta: Meta<typeof BootFailureCard> = { title: "Screens/BootFailureCard", component: BootFailureCard, parameters: { layout: "fullscreen" } }
export default meta

/** Boot `failure` state (13.1). */
export const Default: StoryObj<typeof BootFailureCard> = {
  args: {
    error: "Error: connect ECONNREFUSED 127.0.0.1:4317",
    onRetry: () => {},
    getDiagnostics: () => Promise.resolve("diagnostics")
  }
}
