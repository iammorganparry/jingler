import type { Meta, StoryObj } from "@storybook/react-vite"
import { useRef, useState } from "react"
import { Bell, Home, Settings, Sparkles } from "lucide-react"
import {
  ActionSwap,
  AnimatedBadge,
  AnimatedContextMenu,
  AnimatedCTAButton,
  AnimatedNumber,
  AnimatedSidebar,
  AnimatedText,
  AnimatedToastStack,
  BEUI_MOTION_COMPONENTS,
  BottomSheet,
  BounceSidebar,
  BouncyAccordion,
  CenterMorphModal,
  Combobox,
  CylinderCarousel,
  DataTable,
  Dock,
  Drawer,
  ExpandableControl,
  Loader,
  Marquee,
  MorphingModal,
  MotionButton,
  MotionCheckbox,
  MotionInput,
  MotionPopover,
  MotionSelect,
  MotionSwitch,
  MotionTabs,
  MotionTooltip,
  PreviewRail,
  PullToRefresh,
  RadioGroup,
  RangeSlider,
  ScrollProgress,
  ShaderBackground,
  SharedLayoutBackground,
  ThemeToggle,
  TiltCard,
  WheelPicker
} from "./index.js"

const meta: Meta = { title: "Atoms/BeUI Motion Catalog" }
export default meta
type Story = StoryObj

function Spec({ name, children }: { name: string; children: React.ReactNode }) {
  return <section className="flex min-h-28 flex-col gap-3 rounded-lg border border-line bg-panel p-3"><h3 className="font-mono text-[10px] text-dim">{name}</h3><div className="flex flex-1 items-center justify-center">{children}</div></section>
}

function CatalogDemo() {
  const [tab, setTab] = useState("one")
  const [choice, setChoice] = useState("one")
  const [range, setRange] = useState(40)
  const [open, setOpen] = useState(false)
  const [modal, setModal] = useState<"morph" | "center" | "drawer" | "sheet">()
  const [count, setCount] = useState(7)
  const [sidebar, setSidebar] = useState(true)
  const [carousel, setCarousel] = useState(1)
  const scrollRef = useRef<HTMLDivElement>(null)
  const nav = [{ id: "home", icon: <Home className="size-4" />, label: "Home" }, { id: "settings", icon: <Settings className="size-4" />, label: "Settings" }]
  const options = [{ value: "one", label: "One" }, { value: "two", label: "Two" }]
  return <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
    <Spec name="tilt-card"><TiltCard className="p-6">Pointer tilt</TiltCard></Spec>
    <Spec name="button"><MotionButton>Spring button</MotionButton></Spec>
    <Spec name="expanding-arrow-button"><AnimatedCTAButton>Continue</AnimatedCTAButton></Spec>
    <Spec name="expandable-control"><ExpandableControl icon={<Sparkles className="size-4" />} label="Actions" /></Spec>
    <Spec name="marquee"><Marquee className="w-48"><span>Build</span><span>Test</span><span>Ship</span></Marquee></Spec>
    <Spec name="tabs"><MotionTabs items={options} value={tab} onChange={setTab} /></Spec>
    <Spec name="switch"><MotionSwitch checked={open} onCheckedChange={setOpen} /></Spec>
    <Spec name="input"><MotionInput label="Repository" placeholder="jingler" success /></Spec>
    <Spec name="select"><div className="w-40"><MotionSelect options={options} value={choice} onValueChange={setChoice} /></div></Spec>
    <Spec name="combobox"><div className="w-48"><Combobox options={options.map(item => ({ ...item, label: String(item.label) }))} value={choice} onValueChange={setChoice} /></div></Spec>
    <Spec name="checkbox"><MotionCheckbox checked={open} onCheckedChange={value => setOpen(Boolean(value))} /></Spec>
    <Spec name="radio"><RadioGroup options={options} value={choice} onValueChange={setChoice} /></Spec>
    <Spec name="bottom-sheet"><button onClick={() => setModal("sheet")}>Open sheet</button><BottomSheet open={modal === "sheet"} onOpenChange={() => setModal(undefined)}>Sheet content</BottomSheet></Spec>
    <Spec name="pull-to-refresh"><PullToRefresh onRefresh={() => Promise.resolve()}><div className="rounded border border-line p-3">Pull down</div></PullToRefresh></Spec>
    <Spec name="shared-layout-bg"><SharedLayoutBackground items={options.map(item => ({ id: item.value, label: item.label }))} activeId={choice} onSelect={setChoice} /></Spec>
    <Spec name="bounce-sidebar"><BounceSidebar items={nav} activeId="home" /></Spec>
    <Spec name="animated-sidebar"><div className="h-28 overflow-hidden"><AnimatedSidebar open={sidebar} onOpenChange={setSidebar}><div className="p-3">Sidebar</div></AnimatedSidebar></div></Spec>
    <Spec name="preview-rail"><PreviewRail items={options.map(item => ({ id: item.value, label: String(item.label) }))} activeId={choice} onSelect={item => setChoice(item.id)} /></Spec>
    <Spec name="dock"><Dock items={nav} activeId="home" /></Spec>
    <Spec name="tooltip"><MotionTooltip trigger={<button>Hover me</button>}>Helpful detail</MotionTooltip></Spec>
    <Spec name="context-menu"><AnimatedContextMenu trigger={<div className="rounded border border-line p-3">Right click</div>} items={[{ id: "copy", label: "Copy" }]} /></Spec>
    <Spec name="popover"><MotionPopover trigger={<button>Open popover</button>}>Popover content</MotionPopover></Spec>
    <Spec name="morphing-modal"><button onClick={() => setModal("morph")}>Open modal</button><MorphingModal open={modal === "morph"} onOpenChange={() => setModal(undefined)} title="Morphing modal">Content</MorphingModal></Spec>
    <Spec name="center-morph-modal"><button onClick={() => setModal("center")}>Open center modal</button><CenterMorphModal open={modal === "center"} onOpenChange={() => setModal(undefined)} title="Center modal">Content</CenterMorphModal></Spec>
    <Spec name="text-animation"><AnimatedText mode="shimmer">Streaming response</AnimatedText></Spec>
    <Spec name="number"><button onClick={() => setCount(value => value + 1)}><AnimatedNumber value={count} /></button></Spec>
    <Spec name="animated-badge"><AnimatedBadge tone="success" icon={<Bell className="size-3" />}>Ready</AnimatedBadge></Spec>
    <Spec name="action-swap"><ActionSwap value={String(open)}>{open ? "Stop" : "Send"}</ActionSwap></Spec>
    <Spec name="animated-toast-stack"><AnimatedToastStack items={[{ id: "one", title: "Build complete", tone: "success" }]} /></Spec>
    <Spec name="theme-toggle"><ThemeToggle theme="dark" /></Spec>
    <Spec name="bouncy-accordion"><BouncyAccordion items={[{ id: "one", title: "Tool output", content: "Completed successfully" }]} value={open ? "one" : undefined} onValueChange={value => setOpen(Boolean(value))} /></Spec>
    <Spec name="drawer"><button onClick={() => setModal("drawer")}>Open drawer</button><Drawer open={modal === "drawer"} onOpenChange={() => setModal(undefined)} title="Inspector">Drawer content</Drawer></Spec>
    <Spec name="scroll-animation"><div className="w-48"><ScrollProgress container={scrollRef} /><div ref={scrollRef} className="h-16 overflow-auto"><div className="h-48 p-2">Scroll me</div></div></div></Spec>
    <Spec name="range-slider"><div className="w-48"><RangeSlider value={range} onChange={setRange} /></div></Spec>
    <Spec name="wheel-picker"><div className="w-32"><WheelPicker options={options} value={choice} onValueChange={setChoice} /></div></Spec>
    <Spec name="table"><DataTable rows={[{ id: "1", name: "Build" }, { id: "2", name: "Test" }]} columns={[{ id: "name", header: "Task", cell: row => row.name, sortValue: row => row.name }]} /></Spec>
    <Spec name="shader-background"><ShaderBackground className="h-24 w-48 rounded-lg" /></Spec>
    <Spec name="cylinder-carousel"><CylinderCarousel items={["One", "Two", "Three"]} value={carousel} onValueChange={setCarousel} /></Spec>
    <Spec name="loader"><div className="flex gap-3"><Loader /><Loader variant="dots" /><Loader variant="ascii" /></div></Spec>
    <Spec name="catalog-check"><span className="font-mono text-[11px] text-green">{BEUI_MOTION_COMPONENTS.length}/39 exported</span></Spec>
  </div>
}

export const AllMotionComponents: Story = { render: () => <CatalogDemo /> }
