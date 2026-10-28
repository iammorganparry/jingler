import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { PrSwitcher } from "./pr-switcher.js"

const meta: Meta = { title: "Composites/PR Switcher", parameters: { layout: "centered" } }
export default meta
type Story = StoryObj

const LAYERS = [
  { number: 480, branch: "stack/model", state: "merged" as const },
  { number: 481, branch: "stack/api", state: "open" as const },
  { number: 482, branch: "stack/ui", state: "open" as const, checks: "fail" as const }
]

/** Board 04m: `PR #482 ▾ 2/3`; ⌥[ / ⌥] move through the stack. */
export const Default: Story = {
  render: () => {
    const [selected, setSelected] = useState(482)
    const step = (delta: -1 | 1) =>
      setSelected((current) => LAYERS[LAYERS.findIndex((l) => l.number === current) + delta]?.number ?? current)
    return (
      <div className="bg-panel p-6">
        <PrSwitcher
          layers={LAYERS}
          selected={selected}
          onSelect={setSelected}
          onStep={step}
          mergeState="idle"
          merged={0}
          mergeError={null}
          onMergeStack={() => {}}
        />
      </div>
    )
  }
}
