import type { Meta, StoryObj } from "@storybook/react-vite"
import { useEffect, useRef, useState } from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { Check, Copy, Download, Eye, Pencil, Trash2 } from "lucide-react"
import { ContextMenu as JinglerContextMenu } from "./context-menu.js"
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger
} from "./beui/context-menu.js"
import { SPRING_SWAP } from "./beui/ease.js"

const meta: Meta = {
  title: "Review/Context Menu",
  parameters: { layout: "fullscreen" }
}
export default meta
type Story = StoryObj

function openAtCenter(ref: React.RefObject<HTMLElement | null>) {
  const rect = ref.current?.getBoundingClientRect()
  if (!rect) return
  ref.current?.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2
  }))
}

function CurrentFixture() {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const timeout = window.setTimeout(() => openAtCenter(ref), 250)
    return () => window.clearTimeout(timeout)
  }, [])
  return (
    <JinglerContextMenu items={[
      { label: "Rename", icon: Pencil, onSelect: () => {} },
      { label: "Duplicate", icon: Copy, onSelect: () => {} },
      { label: "Delete", icon: Trash2, tone: "danger", separated: true, onSelect: () => {} }
    ]}>
      <button ref={ref} type="button" className="h-32 w-56 rounded-2xl border border-line bg-panel text-sm text-text-body">Right-click session</button>
    </JinglerContextMenu>
  )
}

function BeUIBaseline() {
  const reduce = useReducedMotion() ?? false
  const [message, setMessage] = useState<string | null>(null)
  const [offline, setOffline] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const timeout = window.setTimeout(() => openAtCenter(ref), 350)
    return () => window.clearTimeout(timeout)
  }, [])
  return (
    <div className="flex min-h-[360px] w-full items-center justify-center">
      <ContextMenu>
        <ContextMenuTrigger>
          <button ref={ref} type="button" className="group flex flex-col items-center outline-none">
            <div className="relative h-24 w-32 transition-transform duration-150 group-active:scale-[0.98] group-focus-visible:rounded-2xl group-focus-visible:ring-2 group-focus-visible:ring-text-bright/20 group-focus-visible:ring-offset-4 group-focus-visible:ring-offset-canvas">
              <div className="absolute left-1 top-1 h-7 w-14 rounded-t-[10px] bg-[#d4a84f] dark:bg-[#a77d2f]" />
              <div className="absolute inset-x-0 bottom-0 top-5 rounded-[14px] bg-[#e7bb61] shadow-[0_14px_24px_-16px_rgba(90,58,8,0.75)] dark:bg-[#bd8d36]" />
              <div className="absolute inset-x-0 bottom-0 top-9 rounded-[14px] bg-[#efc86f] dark:bg-[#cb9a41]" />
              <div className="absolute inset-x-5 bottom-4 h-px bg-black/10 dark:bg-white/10" />
            </div>
            <span className="mt-4 text-sm font-medium text-text-bright">Right click on me</span>
            <div className="mt-1 h-4">
              <AnimatePresence mode="wait" initial={false}>
                {message ? (
                  <motion.span key={message} initial={reduce ? { opacity: 0 } : { opacity: 0, y: 3, filter: "blur(2px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={reduce ? { opacity: 0 } : { opacity: 0, y: -2, filter: "blur(2px)" }} transition={reduce ? { duration: 0.1 } : SPRING_SWAP} className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <Check aria-hidden="true" className="h-3 w-3 text-green" />{message}
                  </motion.span>
                ) : <span className="text-[10px] text-muted-foreground">or long-press · Shift + F10</span>}
              </AnimatePresence>
            </div>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent ariaLabel="Folder actions" className="w-60">
          <ContextMenuLabel>Project files</ContextMenuLabel>
          <ContextMenuItem textValue="Open" onSelect={() => setMessage("Folder opened")}><Eye aria-hidden="true" className="h-4 w-4" />Open<ContextMenuShortcut>↵</ContextMenuShortcut></ContextMenuItem>
          <ContextMenuItem textValue="Rename" onSelect={() => setMessage("Ready to rename")}><Pencil aria-hidden="true" className="h-4 w-4" />Rename<ContextMenuShortcut>R</ContextMenuShortcut></ContextMenuItem>
          <ContextMenuItem textValue="Duplicate" onSelect={() => setMessage("Folder duplicated")}><Copy aria-hidden="true" className="h-4 w-4" />Duplicate<ContextMenuShortcut>⌘D</ContextMenuShortcut></ContextMenuItem>
          <ContextMenuItem textValue="Download" onSelect={() => setMessage("Download started")}><Download aria-hidden="true" className="h-4 w-4" />Download</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuCheckboxItem textValue="Keep offline" checked={offline} closeOnSelect={false} onCheckedChange={(checked) => { setOffline(checked); setMessage(checked ? "Available offline" : "Online only") }}>Keep offline</ContextMenuCheckboxItem>
          <ContextMenuSeparator />
          <ContextMenuItem tone="destructive" textValue="Move to trash" onSelect={() => setMessage("Moved to trash")}><Trash2 aria-hidden="true" className="h-4 w-4" />Move to trash<ContextMenuShortcut>⌘⌫</ContextMenuShortcut></ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  )
}

export const CurrentVsProposed: Story = {
  render: () => (
    <main className="flex h-screen min-h-[680px] flex-col bg-canvas p-5 text-text">
      <header className="mx-auto w-full max-w-[1080px]">
        <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-brand">Exact baseline review</div>
        <h1 className="mt-1 text-lg font-semibold text-text-bright">Context Menu</h1>
        <p className="mt-1 text-xs text-muted-foreground">Current production beside the official beui.dev preview rendered from the ported primitive.</p>
      </header>
      <div className="mx-auto mt-5 grid min-h-0 w-full max-w-[1080px] flex-1 grid-cols-2 gap-4">
        <section className="relative grid place-items-center rounded-xl border border-line bg-editor"><CurrentFixture /></section>
        <section className="relative grid place-items-center rounded-xl border border-line bg-editor"><BeUIBaseline /></section>
      </div>
    </main>
  )
}
