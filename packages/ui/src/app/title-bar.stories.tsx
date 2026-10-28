import type { Meta, StoryObj } from "@storybook/react-vite"
import { TitleBar } from "./title-bar.js"

const meta: Meta<typeof TitleBar> = { title: "App/TitleBar", component: TitleBar, decorators: [(Story) => <div className="w-[1100px] bg-editor"><Story /></div>] }
export default meta
type Story = StoryObj<typeof TitleBar>

/** macOS: native traffic lights, 44px inset, no overlay (board 00). */
export const MacOS: Story = { args: { platform: "darwin" } }
/** Windows: minimise / maximise / close overlay; Close is the only red hover. */
export const Windows: Story = { args: { platform: "win32" } }
export const WindowsMaximized: Story = { args: { platform: "win32", windowControls: { maximized: true } } }
export const Linux: Story = { args: { platform: "linux" } }
