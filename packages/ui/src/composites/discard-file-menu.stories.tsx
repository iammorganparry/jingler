import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { DiscardFileMenu } from "./discard-file-menu.js"

const meta: Meta = { title: "Composites/Discard File Menu" }
export default meta
type Story = StoryObj

function Harness() {
  const [log, setLog] = useState("Right-click a.ts, then confirm")
  return (
    <div className="w-[280px] rounded-lg border border-line bg-panel p-2 text-[12px] text-text-body">
      <DiscardFileMenu paths={new Set(["src/a.ts"])} onDiscard={(path) => setLog(`Discarded ${path}`)}>
        <div>
          <div data-item-path="src/a.ts" className="rounded px-2 py-1 hover:bg-hover">a.ts</div>
          <div data-item-path="src/b.ts" className="rounded px-2 py-1 hover:bg-hover">b.ts (nothing to discard)</div>
        </div>
      </DiscardFileMenu>
      <div className="mt-2 text-dim">{log}</div>
    </div>
  )
}

/** The right-click menu and its confirmation, on a plain two-row list. */
export const Default: Story = { render: () => <Harness /> }
