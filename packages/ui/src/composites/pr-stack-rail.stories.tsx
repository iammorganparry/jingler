import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { PrStackRail, type PrStackLayer } from "./pr-stack-rail.js"

const meta: Meta = { title: "Composites/PR Stack Rail", parameters: { layout: "centered" } }
export default meta
type Story = StoryObj

const LAYERS: ReadonlyArray<PrStackLayer> = [
  { number: 480, title: "Add stack model", branch: "stack/model", state: "merged", checks: "pass" },
  { number: 481, title: "Stack API", branch: "stack/api", state: "open", checks: "pass" },
  { number: 482, title: "Stack rail UI", branch: "stack/ui", state: "open", checks: "fail" }
]

/** Board 04m: #480 merged, #481 open, #482 open with a failing check and selected. */
export const Default: Story = {
  render: () => {
    const [selected, setSelected] = useState<number | null>(482)
    return (
      <div className="bg-panel p-6">
        <PrStackRail layers={LAYERS} selected={selected} onSelect={setSelected} />
      </div>
    )
  }
}
