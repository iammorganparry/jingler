import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { Command as CommandPrimitive } from "cmdk"
import { Search } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { cn } from "../lib/cn.js"
import { paletteOverlayVariants, paletteVariants } from "../lib/motion.js"
import {
  Dialog,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle
} from "./dialog.js"

export const Command = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    className={cn("flex w-full flex-col overflow-hidden rounded-lg bg-panel text-text", className)}
    {...props}
  />
))
Command.displayName = CommandPrimitive.displayName

/** The global palette remains a dialog; composer pickers use Command inside Popover. */
export function CommandDialog({
  open,
  onOpenChange,
  title = "Command palette",
  description = "Search for a session or run a command.",
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof CommandPrimitive> & {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: string
  description?: string
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <AnimatePresence mode="wait">
        {open && (
          <DialogPortal forceMount>
            <DialogOverlay asChild forceMount>
              <motion.div
                initial="hidden"
                animate="visible"
                exit="exit"
                variants={paletteOverlayVariants}
              />
            </DialogOverlay>
            <DialogPrimitive.Content
              forceMount
              className="fixed left-1/2 top-[12vh] z-50 w-[600px] max-w-[92vw] -translate-x-1/2 outline-none"
            >
              <DialogTitle className="sr-only">{title}</DialogTitle>
              <DialogDescription className="sr-only">{description}</DialogDescription>
              <motion.div
                initial="hidden"
                animate="visible"
                exit="exit"
                variants={paletteVariants}
                className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-line shadow-[0_16px_48px_var(--sb-shadow-strong)]"
              >
                <Command className={className} {...props}>
                  {children}
                </Command>
              </motion.div>
            </DialogPrimitive.Content>
          </DialogPortal>
        )}
      </AnimatePresence>
    </Dialog>
  )
}
CommandDialog.displayName = "CommandDialog"

export const CommandInput = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Input>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(({ className, ...props }, ref) => (
  <div
    className="mx-2 mt-2 flex h-10 items-center gap-2 rounded-lg border border-line bg-surface px-2"
    cmdk-input-wrapper=""
  >
    <Search size={15} className="flex-none text-muted-foreground" aria-hidden />
    <CommandPrimitive.Input
      ref={ref}
      className={cn(
        "min-w-0 flex-1 bg-transparent text-[13px] text-text-bright outline-none placeholder:text-dim disabled:opacity-50",
        className
      )}
      {...props}
    />
  </div>
))
CommandInput.displayName = CommandPrimitive.Input.displayName

export const CommandList = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.List
    ref={ref}
    className={cn("max-h-[320px] overflow-y-auto overflow-x-hidden p-2", className)}
    {...props}
  />
))
CommandList.displayName = CommandPrimitive.List.displayName

export const CommandEmpty = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Empty>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Empty
    ref={ref}
    className={cn("py-8 text-center text-[12px] text-muted-foreground", className)}
    {...props}
  />
))
CommandEmpty.displayName = CommandPrimitive.Empty.displayName

export const CommandGroup = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    className={cn(
      "overflow-hidden text-text-body [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground",
      className
    )}
    {...props}
  />
))
CommandGroup.displayName = CommandPrimitive.Group.displayName

export const CommandItem = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-2 text-[13px] text-text-body outline-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-40 data-[selected=true]:bg-surface data-[selected=true]:text-text-bright",
      className
    )}
    {...props}
  />
))
CommandItem.displayName = CommandPrimitive.Item.displayName

export const CommandSeparator = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-line", className)}
    {...props}
  />
))
CommandSeparator.displayName = CommandPrimitive.Separator.displayName

export function CommandShortcut({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn("ml-auto shrink-0 text-[11px] tracking-widest text-dim", className)}
      {...props}
    />
  )
}
CommandShortcut.displayName = "CommandShortcut"
