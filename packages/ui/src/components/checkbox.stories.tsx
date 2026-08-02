import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { Checkbox } from "./checkbox.js"

/**
 * The shadcn-size `Checkbox` atom (size-4). `tone="accent"` fills with the brand;
 * `tone="success"` is the green tick used for the Code Review "viewed" toggle.
 */
const meta: Meta = { title: "Atoms/Checkbox" }
export default meta
type Story = StoryObj

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-[12px] text-text">
      <span className="w-40 text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

export const States: Story = {
  render: () => (
    <div className="flex flex-col gap-3 bg-panel p-4">
      <Row label="accent · unchecked">
        <Checkbox tone="accent" checked={false} aria-label="a" />
      </Row>
      <Row label="accent · checked">
        <Checkbox tone="accent" checked aria-label="b" />
      </Row>
      <Row label="success · unchecked">
        <Checkbox tone="success" checked={false} aria-label="c" />
      </Row>
      <Row label="success · checked (viewed)">
        <Checkbox tone="success" checked aria-label="d" />
      </Row>
      <Row label="disabled · checked">
        <Checkbox tone="accent" checked disabled aria-label="e" />
      </Row>
    </div>
  )
}

export const Interactive: Story = {
  render: function Render() {
    const [accent, setAccent] = useState(false)
    const [viewed, setViewed] = useState(true)
    return (
      <div className="flex flex-col gap-3 bg-panel p-4">
        <Row label="accent (click me)">
          <Checkbox tone="accent" checked={accent} onCheckedChange={setAccent} aria-label="accent" />
          <span className="text-dim">{accent ? "on" : "off"}</span>
        </Row>
        <Row label="success (click me)">
          <Checkbox tone="success" checked={viewed} onCheckedChange={setViewed} aria-label="viewed" />
          <span className="text-dim">{viewed ? "viewed" : "not viewed"}</span>
        </Row>
      </div>
    )
  }
}
