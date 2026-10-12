import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { SettingsCard, SettingsRow } from "./settings-row.js"
import { Toggle } from "./toggle.js"

const meta: Meta = { title: "Molecules/SettingsCard" }
export default meta
type Story = StoryObj

/** Settings → General card (board 09a). */
export const General: Story = {
  render: function Render() {
    const [adhd, setAdhd] = useState(true)
    const [offload, setOffload] = useState(false)
    return (
      <div className="w-[720px] bg-editor p-6">
        <SettingsCard title="General">
          <SettingsRow label="ADHD mode" help="Shorter replies that lead with the next action." control={<Toggle aria-label="ADHD mode" checked={adhd} onCheckedChange={setAdhd} />} />
          <SettingsRow label="Offload compute" help="Run eligible builds and tests on remote machines. Long help text wraps here and never pushes the control off the row, no matter how much there is to say." control={<Toggle aria-label="Offload compute" checked={offload} onCheckedChange={setOffload} />} />
        </SettingsCard>
      </div>
    )
  }
}
