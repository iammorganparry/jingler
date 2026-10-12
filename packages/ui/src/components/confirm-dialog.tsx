import { useRef, useState, type ReactNode } from "react"
import { Button } from "./button.js"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "./dialog.js"

/**
 * A small yes/no confirmation modal for destructive or irreversible actions
 * (e.g. deleting a session). Controlled via `open`/`onOpenChange`; `onConfirm`
 * fires then the dialog closes unless `closeOnConfirm={false}` leaves closing to
 * the caller. `tone="danger"` gives the confirm button the solid destructive fill (the only place one is allowed).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  onConfirm,
  closeOnConfirm = true
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: "default" | "danger"
  closeOnConfirm?: boolean
  onConfirm: () => void | Promise<void>
}) {
  const [pending, setPending] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirm = () => {
    if (pending) return
    setPending(true)
    void Promise.resolve(onConfirm())
      .then(() => { if (closeOnConfirm) onOpenChange(false) })
      .catch(() => {})
      .finally(() => setPending(false))
  }
  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent
        className="w-[420px]"
        // Destructive dialogs start on the safe button so Enter can't confirm by accident.
        onOpenAutoFocus={tone === "danger" ? (event) => { event.preventDefault(); cancelRef.current?.focus() } : undefined}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {description && (
          <DialogBody>
            <DialogDescription>{description}</DialogDescription>
          </DialogBody>
        )}
        <DialogFooter>
          <Button ref={cancelRef} variant="secondary" size="sm" disabled={pending} onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "destructive-solid" : "primary"}
            size="sm"
            disabled={pending}
            aria-busy={pending}
            onClick={confirm}
          >
            {pending ? `${confirmLabel}…` : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
