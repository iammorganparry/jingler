import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { Check, ChevronDown } from "lucide-react"
import { useEffect } from "react"
import { Button } from "../components/button.js"
import { cn } from "../lib/cn.js"
import { PR_STATE_LABEL, type PrStackNav } from "./pr-stack-rail.js"
import { menuItemClass } from "./pr-view-header.js"

/** ⌥[ steps down the stack, ⌥] steps up. Matched on `code`: macOS rewrites `key` under Option. */
export const matchStackStepChord = (
  e: Pick<KeyboardEvent, "code" | "altKey" | "metaKey" | "ctrlKey" | "shiftKey">
): -1 | 1 | null => {
  if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return null
  if (e.code === "BracketLeft") return -1
  return e.code === "BracketRight" ? 1 : null
}

/**
 * Header stack switcher: `PR #482 ▾ 2/3`. The menu lists the stack base-up; merged layers are dimmed with a tick.
 * Owns the ⌥[ / ⌥] chord while mounted (the PR view only mounts on the PR tab).
 */
export function PrSwitcher({ layers, selected, onSelect, onStep }: PrStackNav) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const delta = matchStackStepChord(e)
      if (delta === null) return
      e.preventDefault()
      onStep(delta)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onStep])

  const index = layers.findIndex((layer) => layer.number === selected)
  if (index < 0) return null
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-testid="pr-switcher"
          aria-label="Switch pull request in stack"
          className="h-7 shrink-0 gap-1.5 px-2 font-mono text-[11.5px]"
        >
          PR #{selected}
          <ChevronDown size={12} aria-hidden />
          <span className="text-dim">
            {index + 1}/{layers.length}
          </span>
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 flex min-w-[280px] flex-col gap-0.5 rounded-lg border border-line bg-sunken p-1.5 shadow-2xl"
        >
          {layers.map((layer) => {
            const current = layer.number === selected
            return (
              <DropdownMenu.Item
                key={layer.number}
                data-testid={`pr-switcher-item-${layer.number}`}
                aria-current={current ? "true" : undefined}
                onSelect={() => onSelect(layer.number)}
                className={cn(menuItemClass, current && "bg-surface text-text-bright", layer.state === "merged" && !current && "opacity-60")}
              >
                <span className="font-mono text-[12px]">#{layer.number}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground">{layer.branch}</span>
                {layer.state && <span className="text-[11px] text-dim">{PR_STATE_LABEL[layer.state]}</span>}
                {layer.state === "merged" && <Check size={12} aria-hidden />}
              </DropdownMenu.Item>
            )
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
