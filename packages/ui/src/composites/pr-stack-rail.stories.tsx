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

const UNMERGED_LAYERS: ReadonlyArray<PrStackLayer> = [
  { number: 480, title: "Add stack model", branch: "stack/model", state: "open", checks: "pass" },
  { number: 481, title: "Stack API", branch: "stack/api", state: "open", checks: "pass" },
  { number: 482, title: "Stack rail UI", branch: "stack/ui", state: "open", checks: "pass" }
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

/** Idle: every layer green, "Merge stack" CTA ready. */
export const MergeStackIdle: Story = {
  render: () => (
    <div className="bg-panel p-6">
      <PrStackRail layers={UNMERGED_LAYERS} selected={482} onSelect={() => {}} mergeState="idle" merged={0} mergeError={null} onMergeStack={() => {}} />
    </div>
  )
}

const MERGING_LAYERS: ReadonlyArray<PrStackLayer> = [
  { ...UNMERGED_LAYERS[0]!, state: "merged" },
  UNMERGED_LAYERS[1]!,
  UNMERGED_LAYERS[2]!
]

/** Merging: the base layer has landed, the CTA shows per-layer progress. */
export const MergeStackMerging: Story = {
  render: () => (
    <div className="bg-panel p-6">
      <PrStackRail
        layers={MERGING_LAYERS}
        selected={482}
        onSelect={() => {}}
        mergeState="merging"
        merged={1}
        mergeError={null}
        onMergeStack={() => {}}
      />
    </div>
  )
}

/** Failed: the run stopped on #481, which stays unmerged alongside the error. */
export const MergeStackFailed: Story = {
  render: () => (
    <div className="bg-panel p-6">
      <PrStackRail
        layers={MERGING_LAYERS}
        selected={482}
        onSelect={() => {}}
        mergeState="failed"
        merged={1}
        mergeError="Failed to merge #481: merge conflict"
        onMergeStack={() => {}}
      />
    </div>
  )
}
