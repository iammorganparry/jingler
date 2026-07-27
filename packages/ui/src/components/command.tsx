import * as React from "react"
import { Command as CommandPrimitive } from "cmdk"
import { Search } from "lucide-react"
import { motion } from "motion/react"
import { cn } from "../lib/cn.js"
import { paletteVariants } from "../lib/motion.js"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog.js"

/**
 * shadcn's Command (cmdk), restyled to Starbase's tokens.
 *
 * ## Why cmdk rather than a listbox of our own
 *
 * A command list is more keyboard than it looks: arrow navigation that skips
 * group headings, wrap-around, type-ahead, `aria-activedescendant` pointed at a
 * row the input never gives focus to, and scrolling the active row into view
 * without stealing the caret. cmdk owns all of it. The composer's `/` menu
 * (`composites/command-menu.tsx`) hand-rolls a smaller version of the same
 * thing, and it is the reason `activeIndex` arithmetic appears in
 * `composer.tsx` at all.
 *
 * ## What was changed on the way in
 *
 * Every colour. shadcn ships `bg-popover` / `text-slate-*`, which in this
 * codebase are invisible to the theme system — they survive a theme switch
 * unchanged, which on a light theme means white on white. Each is translated to
 * an `--sb-*`-backed utility here, per the rule in `CLAUDE.md`.
 *
 * `CommandDialog` is built on `dialog.tsx` rather than mounting its own Radix
 * Dialog, so focus trapping and Escape have exactly one implementation in the
 * app.
 */

export const Command = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    className={cn(
      "flex h-full w-full flex-col overflow-hidden rounded-xl bg-panel text-text",
      className
    )}
    {...props}
  />
))
Command.displayName = CommandPrimitive.displayName

/**
 * The palette's window: top-anchored, not centred, and it springs in.
 *
 * A centred dialog moves as it grows and shrinks, so the row under the cursor
 * slides while you type — which is exactly when you are least able to tolerate
 * it. Anchored near the top, the input stays put and only the list below it
 * changes length.
 *
 * ## Why the card, and not `DialogContent`, is the thing that animates
 *
 * `DialogContent` positions itself with `-translate-x-1/2`, and Motion writes
 * the element's whole `transform`. Animating scale on that element would drop
 * the centring on the first frame and the palette would fly in from the left.
 * So the positioned box is left transparent and the chrome — border, shadow,
 * radius — moves onto the `motion.div` inside it, which owns a transform nobody
 * else is writing.
 *
 * Reduced motion is not checked here: `MotionConfig reducedMotion="user"` in
 * `app-shell` (and the Storybook preview) makes the transform instant, which is
 * the one place the app honours the preference.
 *
 * The title and description are present but visually hidden: Radix requires
 * both for the dialog to be announced, and a palette has no room for a heading.
 */
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
      <DialogContent
        hideClose
        // Stripped to a positioned, transparent frame. `overflow-visible` so the
        // card's shadow is not clipped by a box that no longer draws anything.
        className="top-[12vh] w-[600px] max-w-[92vw] translate-y-0 overflow-visible border-0 bg-transparent p-0 shadow-none"
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        <motion.div
          initial="hidden"
          animate="visible"
          variants={paletteVariants}
          className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-line shadow-[0_16px_48px_var(--sb-shadow-strong)]"
        >
          <Command className={className} {...props}>
            {children}
          </Command>
        </motion.div>
      </DialogContent>
    </Dialog>
  )
}
CommandDialog.displayName = "CommandDialog"

export const CommandInput = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Input>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(({ className, ...props }, ref) => (
  <div className="flex flex-none items-center gap-2.5 border-b border-hairline px-3.5">
    <Search size={14} className="shrink-0 text-dim" aria-hidden />
    <CommandPrimitive.Input
      ref={ref}
      className={cn(
        "flex h-11 w-full bg-transparent text-[13px] text-text-bright outline-none placeholder:text-dim disabled:cursor-not-allowed disabled:opacity-50",
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
    className={cn("max-h-[380px] overflow-y-auto overflow-x-hidden p-1.5", className)}
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

/**
 * A heading and its rows.
 *
 * cmdk hides a group whose every row is filtered out, so a heading over nothing
 * — which reads as a loading state — cannot happen.
 */
export const CommandGroup = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    className={cn(
      "overflow-hidden text-text [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-dim",
      className
    )}
    {...props}
  />
))
CommandGroup.displayName = CommandPrimitive.Group.displayName

export const CommandSeparator = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Separator
    ref={ref}
    className={cn("-mx-1.5 my-1 h-px bg-hairline", className)}
    {...props}
  />
))
CommandSeparator.displayName = CommandPrimitive.Separator.displayName

/**
 * One row.
 *
 * The active row is marked by cmdk with `data-selected`, and it is a HOVER-like
 * highlight rather than a focus ring on purpose: the caret stays in the input
 * the whole time, so a ring here would claim a focus the element does not have.
 */
export const CommandItem = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-default select-none items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-text outline-none",
      "data-[selected=true]:bg-surface data-[selected=true]:text-text-bright",
      "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
      className
    )}
    {...props}
  />
))
CommandItem.displayName = CommandPrimitive.Item.displayName

/** The right-aligned chord on a row. Display only — it binds nothing. */
export function CommandShortcut({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn("ml-auto shrink-0 text-[11px] tracking-widest text-dim", className)}
      {...props}
    />
  )
}
CommandShortcut.displayName = "CommandShortcut"
