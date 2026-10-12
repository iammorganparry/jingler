import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { SegmentedControl } from "./segmented-control.js"

const meta: Meta = { title: "Atoms/SegmentedControl" }
export default meta
type Story = StoryObj

/** Sidebar `Sessions | Explorer` toggle: 28px, full width (board 04l). */
export const SidebarToggle: Story = {
  render: function Render() {
    const [value, setValue] = useState<"sessions" | "explorer">("sessions")
    return (
      <div className="w-[248px] bg-panel p-3">
        <SegmentedControl aria-label="Workspace" fullWidth value={value} onChange={setValue}
          items={[{ value: "sessions", label: "Sessions" }, { value: "explorer", label: "Explorer" }]} />
      </div>
    )
  }
}

/** Connect sheet `Subscription · API key` at 24px (board 15). */
export const Small: Story = {
  render: function Render() {
    const [value, setValue] = useState<"subscription" | "api">("subscription")
    return (
      <div className="bg-panel p-3">
        <SegmentedControl size="sm" value={value} onChange={setValue}
          items={[{ value: "subscription", label: "Subscription" }, { value: "api", label: "API key" }]} />
      </div>
    )
  }
}
