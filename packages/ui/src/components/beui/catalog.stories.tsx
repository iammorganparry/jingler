import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { Home, Settings } from "lucide-react"
import { Button } from "../button.js"
import { Input } from "../input.js"
import { Checkbox } from "../checkbox.js"
import { Toggle } from "../toggle.js"
import { Tooltip } from "../tooltip.js"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select.js"
import { AnimatedBadge, Loader, MotionTabs, PreviewRail, Dock, BEUI_MOTION_COMPONENTS } from "./index.js"

const meta: Meta = { title: "Atoms/BeUI Production Catalog" }
export default meta
type Story = StoryObj

function Spec({ name, children }: { name: string; children: React.ReactNode }) {
  return <section className="flex min-h-28 flex-col gap-3 rounded-lg border border-line bg-panel p-3"><h3 className="font-mono text-[10px] text-dim">{name}</h3><div className="flex flex-1 items-center justify-center">{children}</div></section>
}

function CatalogDemo() {
  const [tab, setTab] = useState("one")
  const [choice, setChoice] = useState("one")
  const [checked, setChecked] = useState(false)
  const nav = [{ id: "home", icon: <Home className="size-4" />, label: "Home" }, { id: "settings", icon: <Settings className="size-4" />, label: "Settings" }]
  const options = [{ value: "one", label: "One" }, { value: "two", label: "Two" }]
  return <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
    <Spec name="button"><Button>Squircle button</Button></Spec>
    <Spec name="tabs"><MotionTabs items={options} value={tab} onChange={setTab} /></Spec>
    <Spec name="switch"><Toggle checked={checked} onCheckedChange={setChecked} /></Spec>
    <Spec name="input"><Input placeholder="Repository" /></Spec>
    <Spec name="select"><div className="w-40"><Select value={choice} onValueChange={setChoice}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></div></Spec>
    <Spec name="checkbox"><Checkbox checked={checked} onCheckedChange={setChecked} /></Spec>
    <Spec name="preview-rail"><PreviewRail items={options.map(item => ({ id: item.value, label: item.label }))} activeId={choice} onSelect={item => setChoice(item.id)} /></Spec>
    <Spec name="dock"><Dock items={nav} activeId="home" /></Spec>
    <Spec name="tooltip"><Tooltip label="Helpful detail"><button>Hover me</button></Tooltip></Spec>
    <Spec name="animated-badge"><AnimatedBadge status="success">Ready</AnimatedBadge></Spec>
    <Spec name="loader"><div className="flex gap-3"><Loader /><Loader variant="dots" /></div></Spec>
    <Spec name="catalog-check"><span className="font-mono text-[11px] text-green">{BEUI_MOTION_COMPONENTS.length} production atoms</span></Spec>
  </div>
}

export const ProductionAtoms: Story = { render: () => <CatalogDemo /> }
