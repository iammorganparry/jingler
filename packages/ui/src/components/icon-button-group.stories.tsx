import type { Meta, StoryObj } from "@storybook/react-vite"
import { ArrowLeft, ArrowRight, Monitor, RotateCw, Smartphone, Tablet } from "lucide-react"
import { IconButtonGroup } from "./icon-button-group.js"

const meta = { title: "Atoms/IconButtonGroup", component: IconButtonGroup } satisfies Meta<typeof IconButtonGroup>
export default meta
type Story = StoryObj<typeof meta>

const nav = [
  { id: "back", label: "Back", icon: <ArrowLeft size={14} /> },
  { id: "forward", label: "Forward", icon: <ArrowRight size={14} /> },
  { id: "reload", label: "Reload", icon: <RotateCw size={14} /> }
]

export const Default: Story = { args: { label: "Browser navigation", items: nav } }

export const Disabled: Story = {
  args: { label: "Browser navigation", items: nav.map((item) => (item.id === "reload" ? item : { ...item, disabled: true })) }
}

const widths = [
  { id: "phone", label: "Phone", icon: <Smartphone size={14} />, pressed: false },
  { id: "tablet", label: "Tablet", icon: <Tablet size={14} />, pressed: true },
  { id: "desktop", label: "Desktop", icon: <Monitor size={14} />, pressed: false }
]

export const WithActiveItem: Story = { args: { label: "Device width", items: widths } }

/** Board 21 browser toolbar: navigation group plus device-width group. */
export const BrowserToolbar: Story = {
  args: { label: "Browser navigation", items: nav },
  render: () => (
    <div className="flex items-center gap-2">
      <IconButtonGroup label="Browser navigation" items={[{ ...nav[0]!, disabled: true }, nav[1]!, nav[2]!]} />
      <IconButtonGroup label="Device width" items={widths} />
    </div>
  )
}
