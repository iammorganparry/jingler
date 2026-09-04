import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { cn } from "../lib/cn.js"
import { useNativeEclipsingOverlay } from "../lib/native-overlay.js"

/**
 * shadcn Dialog (Radix) restyled to the One Dark modal: a dimmed window behind a
 * flat `panel` card with bordered header/footer bands. Radix owns
 * focus trapping, Escape/overlay dismissal, and portalling.
 */
export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogPortal = DialogPrimitive.Portal
export const DialogClose = DialogPrimitive.Close

export const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => {
  // A dialog cannot out-z-index an Electron WebContentsView; registering here
  // lets the native browser preview hide itself while any dialog is open.
  useNativeEclipsingOverlay()
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn("fixed inset-0 z-40 bg-editor/10 backdrop-blur-sm", className)}
      {...props}
    />
  )
})
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /** Hide the default top-right close button. */
    hideClose?: boolean
  }
>(function DialogContent({ className, children, hideClose = false, ...props }, ref) {
  const reduce = useReducedMotion()
  return <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content ref={ref} className="fixed left-1/2 top-1/2 z-50 max-w-[90vw] -translate-x-1/2 -translate-y-1/2 outline-none" {...props}>
      <motion.div
        initial={reduce ? { opacity: 0 } : { opacity: 1, clipPath: "inset(48% 48% 48% 48% round 16px)" }}
        animate={{ opacity: 1, clipPath: "inset(0% 0% 0% 0% round 16px)" }}
        transition={reduce ? { duration: 0.14 } : { duration: 0.43, ease: [0.2, 0, 0.2, 1] }}
        className={cn(
          "relative flex max-h-[calc(100vh-4rem)] w-[460px] max-w-[90vw] flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-[0_16px_48px_var(--sb-shadow-strong)] will-change-[clip-path]",
          className
        )}
      >
        {children}
        {!hideClose && (
          <DialogPrimitive.Close className="absolute right-3.5 top-[11px] flex size-8 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-surface hover:text-text focus-visible:ring-2 focus-visible:ring-ring" aria-label="Close">
            <X size={14} />
          </DialogPrimitive.Close>
        )}
      </motion.div>
    </DialogPrimitive.Content>
  </DialogPortal>
})
DialogContent.displayName = DialogPrimitive.Content.displayName

/** Bordered title band at the top of the dialog. */
export function DialogHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex flex-none flex-wrap items-center gap-x-3 gap-y-1 border-b border-hairline px-4 py-3",
        className
      )}
      {...props}
    />
  )
}
DialogHeader.displayName = "DialogHeader"

/** Bordered action band at the bottom of the dialog. */
export function DialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex flex-none items-center justify-end gap-2 border-t border-hairline px-4 py-3",
        className
      )}
      {...props}
    />
  )
}
DialogFooter.displayName = "DialogFooter"

export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("flex-1 text-[13px] font-semibold text-text-bright", className)}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("w-full text-[12px] leading-[1.55] text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

/** Padded body region between the header and footer bands. */
export function DialogBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex-1 overflow-auto px-4 py-4", className)} {...props} />
}
DialogBody.displayName = "DialogBody"
