import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { cn } from "../lib/cn.js"
import { Drawer, DrawerDescription, DrawerTitle } from "../components/drawer.js"
import { DialogOverlay, DialogPortal } from "../components/dialog.js"

export interface ChatDrawerProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  /** The content area the drawer overlays. Portalling here (not the body) keeps the sidebar and rail uncovered. */
  readonly container: HTMLElement
  readonly children: React.ReactNode
  readonly className?: string
}

/**
 * Narrow-window chat lane (<1100px, spec §3b.6): a 400px overlay pinned to the left edge of the
 * content area, over a scrim that covers only that area. Esc and a scrim click close it; focus
 * returns to the opener (the Ask pill or ⌘L).
 */
export function ChatDrawer({ open, onOpenChange, container, children, className }: ChatDrawerProps) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DialogPortal container={container}>
        <DialogOverlay data-testid="chat-drawer-scrim" className="absolute" />
        <DialogPrimitive.Content
          data-testid="chat-drawer"
          className={cn(
            "absolute inset-y-0 left-0 z-50 flex w-[400px] max-w-full min-w-0 flex-col border-r border-line bg-panel shadow-[0_16px_48px_var(--sb-shadow-strong)] outline-none",
            className
          )}
        >
          <DrawerTitle className="sr-only">Chat</DrawerTitle>
          <DrawerDescription className="sr-only">The chat lane, shown over the content in a narrow window.</DrawerDescription>
          {children}
        </DialogPrimitive.Content>
      </DialogPortal>
    </Drawer>
  )
}
