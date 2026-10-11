import type { Meta, StoryObj } from "@storybook/react-vite"
import { CrashScreen } from "./crash-screen.js"

const meta: Meta<typeof CrashScreen> = { title: "Screens/CrashScreen", component: CrashScreen, parameters: { layout: "fullscreen" } }
export default meta

/** Root error boundary card (board 25c+, F8-04). */
export const Default: StoryObj<typeof CrashScreen> = {
  args: { details: "TypeError: Cannot read properties of undefined\n    at SessionPane (session-pane.tsx:42)", onReload: () => {}, onOpenLogs: () => {} }
}
