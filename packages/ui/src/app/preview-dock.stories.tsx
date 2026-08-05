import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { BROWSER_TAB_ID, PreviewDock, type PreviewTab } from "./preview-dock.js"
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
    tabs: [],
    activeId: BROWSER_TAB_ID,
    onSelect: () => {},
    onClose: () => {},
    url: "http://localhost:3000",
    onNavigate: () => {},
    onReload: () => {},
    renderTab: () => null
  }
} satisfies Meta<typeof PreviewDock>

export default meta
type Story = StoryObj<typeof meta>

const BROWSER_TAB: PreviewTab = { id: BROWSER_TAB_ID, kind: "browser", title: "Browser" }

const ASSET_TABS: ReadonlyArray<PreviewTab> = [
  { id: "a1", kind: "asset", title: "spec.md", path: "docs/spec.md" },
  { id: "a2", kind: "asset", title: "results.csv", path: "out/results.csv" },
  { id: "a3", kind: "asset", title: "chart.png", path: "assets/chart.png" }
]

/**
 * The browser tab. Its body is a native `WebContentsView` in the real app, which
 * Storybook has no way to mount — so the placeholder stands in and only the
 * chrome (address bar, dock side, tab strip) is exercised here.
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
          tabs={[BROWSER_TAB]}
          activeId={BROWSER_TAB_ID}
          onSelect={() => {}}
          onClose={() => {}}
          url={url}
          onNavigate={setUrl}
          onReload={() => {}}
          renderTab={() => (
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
 * Several assets open alongside the pinned browser tab. Switching tabs here also
 * demonstrates the rule the dock exists to enforce: the address bar belongs to
 * the browser and disappears for an asset, which has a path rather than a URL.
 */
export const WithAssets: Story = {
  render: () => {
    const [side, setSide] = useState<DockSide>("bottom")
    const [tabs, setTabs] = useState<ReadonlyArray<PreviewTab>>([BROWSER_TAB, ...ASSET_TABS])
    const [activeId, setActiveId] = useState("a1")
    return (
      <Frame side={side}>
        <PreviewDock
          dock={side}
          onDockChange={setSide}
          visible
          onToggle={() => {}}
          tabs={tabs}
          activeId={activeId}
          onSelect={setActiveId}
          onClose={(id) => {
            setTabs((current) => current.filter((t) => t.id !== id))
            if (id === activeId) setActiveId(BROWSER_TAB_ID)
          }}
          url="http://localhost:3000"
          onNavigate={() => {}}
          onReload={() => {}}
          renderTab={(tab) => (
            <div className="absolute inset-0 flex items-center justify-center font-mono text-[12px] text-dim">
              {tab.kind === "browser" ? "Native browser view" : tab.path}
            </div>
          )}
          renderAssetManager={(tab) => (
            <div className="absolute inset-0 flex items-center justify-center font-mono text-[12px] text-dim">
              Persistent repository tree + {tab?.path ?? "asset canvas"}
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
