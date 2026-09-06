import { createPortal } from "react-dom"
import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent, type ReactElement, type ReactNode } from "react"
import { motion, useReducedMotion } from "motion/react"
import { ChevronRight, type LucideIcon } from "lucide-react"
import {
  ContextMenu as BeUIContextMenu,
  ContextMenuContent,
  ContextMenuItem as BeUIContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from "./beui/context-menu.js"
import { SPRING_LAYOUT, SPRING_PANEL } from "./beui/ease.js"
import { cn } from "../lib/cn.js"

export interface ContextMenuItem {
  label: string
  id?: string
  icon?: LucideIcon
  onSelect: () => void
  tone?: "default" | "danger"
  separated?: boolean
  submenu?: ReadonlyArray<ContextMenuItem>
}

const keyOf = (item: ContextMenuItem): string => item.id ?? item.label

type OpenSubmenu = {
  item: ContextMenuItem
  anchor: HTMLButtonElement
  focusFirst: boolean
}

function Submenu({
  state,
  onClose,
  onRootClose
}: {
  state: OpenSubmenu
  onClose: () => void
  onRootClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion() ?? false
  const [active, setActive] = useState(0)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const items = state.item.submenu ?? []

  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const anchor = state.anchor.getBoundingClientRect()
    const rect = menu.getBoundingClientRect()
    const openLeft = anchor.right + 4
    setPosition({
      left: openLeft + rect.width <= window.innerWidth - 8 ? openLeft : anchor.left - rect.width - 4,
      top: Math.min(Math.max(8, anchor.top - 6), window.innerHeight - rect.height - 8)
    })
  }, [state])

  useEffect(() => {
    if (state.focusFirst) ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus()
  }, [state])

  const move = (direction: 1 | -1) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])]
    if (buttons.length === 0) return
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = current < 0 ? 0 : (current + direction + buttons.length) % buttons.length
    buttons[next]?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation()
    switch (event.key) {
case "ArrowDown":
case "ArrowUp": {

      event.preventDefault()
      move(event.key === "ArrowDown" ? 1 : -1)

break
}
case "Home":
case "End": {

      event.preventDefault()
      const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])]
      buttons[event.key === "Home" ? 0 : buttons.length - 1]?.focus()

break
}
case "ArrowLeft":
case "Escape": {

      event.preventDefault()
      onClose()
      state.anchor.focus()

break
}
}
  }

  return createPortal(
    <motion.div
      ref={ref}
      data-context-menu-submenu-portal=""
      role="menu"
      aria-label={state.item.label}
      initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={reduce ? { duration: 0.1 } : SPRING_PANEL}
      style={position}
      onKeyDown={onKeyDown}
      className="fixed z-[101] min-w-56 overflow-hidden rounded-[12px] border border-line bg-panel p-1.5 text-text-bright outline-none [filter:drop-shadow(0_18px_28px_rgba(0,0,0,0.2))]"
    >
      {items.map((item, index) => {
        const Icon = item.icon
        return (
          <button
            key={keyOf(item)}
            type="button"
            role="menuitem"
            onFocus={() => setActive(index)}
            onPointerMove={(event) => {
              if (event.pointerType !== "touch") event.currentTarget.focus()
            }}
            onClick={() => {
              item.onSelect()
              onRootClose()
            }}
            className={cn(
              "relative isolate flex w-full select-none items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-text-bright/15",
              item.tone === "danger" ? "text-red" : "text-text-bright"
            )}
          >
            {active === index && (
              <motion.span
                layoutId="context-submenu-active"
                className={cn("absolute inset-0 -z-10 rounded-[8px]", item.tone === "danger" ? "bg-red/10" : "bg-text-bright/[0.065]")}
                transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
              />
            )}
            {Icon && <Icon aria-hidden="true" className="size-4 shrink-0" />}
            <span className="flex-1">{item.label}</span>
          </button>
        )
      })}
    </motion.div>,
    document.body
  )
}

function Row({
  item,
  submenu,
  setSubmenu
}: {
  item: ContextMenuItem
  submenu: OpenSubmenu | null
  setSubmenu: (submenu: OpenSubmenu | null) => void
}) {
  const Icon = item.icon
  const triggerRef = useRef<HTMLButtonElement>(null)
  const hasSubmenu = item.submenu !== undefined
  const disabled = hasSubmenu && item.submenu!.length === 0
  const openSubmenu = (focusFirst: boolean) => {
    if (!triggerRef.current || disabled) return
    setSubmenu({ item, anchor: triggerRef.current, focusFirst })
  }
  return (
    <BeUIContextMenuItem
      buttonRef={triggerRef}
      textValue={item.label}
      disabled={disabled}
      tone={item.tone === "danger" ? "destructive" : "default"}
      closeOnSelect={!hasSubmenu}
      onSelect={hasSubmenu ? () => openSubmenu(true) : item.onSelect}
      onPointerMove={() => hasSubmenu ? openSubmenu(false) : setSubmenu(null)}
      onKeyDown={(event) => {
        if (hasSubmenu && (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ")) {
          event.preventDefault()
          openSubmenu(true)
        } else if (event.key === "ArrowLeft" && submenu) {
          event.preventDefault()
          setSubmenu(null)
        }
      }}
      aria-haspopup={hasSubmenu ? "menu" : undefined}
      aria-expanded={hasSubmenu ? submenu?.item === item : undefined}
    >
      {Icon && <Icon aria-hidden="true" className="size-4 shrink-0" />}
      <span className="flex-1">{item.label}</span>
      {hasSubmenu && <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />}
    </BeUIContextMenuItem>
  )
}

export function ContextMenu({
  items,
  children
}: {
  items: ReadonlyArray<ContextMenuItem>
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [submenu, setSubmenu] = useState<OpenSubmenu | null>(null)
  const setRootOpen = (next: boolean) => {
    setOpen(next)
    if (!next) setSubmenu(null)
  }
  return (
    <BeUIContextMenu open={open} onOpenChange={setRootOpen}>
      <ContextMenuTrigger>{children as ReactElement<HTMLAttributes<HTMLElement>>}</ContextMenuTrigger>
      <ContextMenuContent ariaLabel="Actions" className="w-60">
        {items.map((item, index) => (
          <div key={keyOf(item)}>
            {item.separated && index > 0 && <ContextMenuSeparator />}
            <Row item={item} submenu={submenu} setSubmenu={setSubmenu} />
          </div>
        ))}
      </ContextMenuContent>
      {submenu && <Submenu state={submenu} onClose={() => setSubmenu(null)} onRootClose={() => setRootOpen(false)} />}
    </BeUIContextMenu>
  )
}
