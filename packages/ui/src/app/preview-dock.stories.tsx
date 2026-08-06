import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { PreviewDock } from "./preview-dock.js"
import type { DockSide } from "./terminal-panel.js"

const meta = {
  title: "App/PreviewDock",
  component: PreviewDock,
  parameters: { layout: "fullscreen" },
  args: {
    dock: "right",
    onDockChange: () => {},
    visible: true,
    onToggle: () => {},
    url: "http://localhost:3000",
    onNavigate: () => {},
    onReload: () => {},
    renderBrowser: () => null
  }
} satisfies Meta<typeof PreviewDock>

export default meta
type Story = StoryObj<typeof meta>

/**
 * The browser tab. Its body is a native `WebContentsView` in the real app, which
 * Storybook has no way to mount — so the placeholder stands in and only the
 * chrome (address bar and dock side) is exercised here.
 */
export const Browser: Story = {
  render: () => {
    const [side, setSide] = useState<DockSide>("right")
    const [url, setUrl] = useState("http://localhost:3000")
    return (
      <Frame side={side}>
        <PreviewDock
          dock={side}
          onDockChange={setSide}
          visible
          onToggle={() => {}}
          url={url}
          onNavigate={setUrl}
          onReload={() => {}}
          renderBrowser={() => (
            <div className="absolute inset-0 flex items-center justify-center text-[12px] text-dim">
              Native browser view renders here — loading {url}
            </div>
          )}
        />
      </Frame>
    )
  }
}

/**
 * The same internet-only browser dock attached below the session workspace.
 */
export const BottomDocked: Story = {
  render: () => {
    const [side, setSide] = useState<DockSide>("bottom")
    return (
      <Frame side={side}>
        <PreviewDock
          dock={side}
          onDockChange={setSide}
          visible
          onToggle={() => {}}
          url="http://localhost:3000"
          onNavigate={() => {}}
          onReload={() => {}}
          renderBrowser={() => (
            <div className="absolute inset-0 flex items-center justify-center font-mono text-[12px] text-dim">
              Native browser view
            </div>
          )}
        />
      </Frame>
    )
  }
}

/**
 * Mirrors `session-split.tsx`'s layout rule, which the dock's own borders assume:
 * a RIGHT dock sits beside the content row, a BOTTOM one stacks under it. Render
 * a bottom-docked panel inside the row instead and it draws a left border down
 * the middle of the window.
 */
function Frame({ side, children }: { side: DockSide; children: React.ReactNode }) {
  return (
    <div className="flex h-screen flex-col bg-editor">
      <div className="flex min-h-0 flex-1 flex-row">
        <div className="flex-1" />
        {side === "right" ? children : null}
      </div>
      {side === "bottom" ? children : null}
    </div>
  )
}
