import { useState, type ReactNode } from "react"
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
 * fires then the dialog closes. `tone="danger"` styles the confirm button red.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  onConfirm
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: "default" | "danger"
  onConfirm: () => void | Promise<void>
}) {
  const [pending, setPending] = useState(false)
  const confirm = () => {
    if (pending) return
    setPending(true)
    void Promise.resolve(onConfirm())
      .then(() => onOpenChange(false))
      .catch(() => {})
      .finally(() => setPending(false))
  }
  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="w-[420px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {description && (
          <DialogBody>
            <DialogDescription>{description}</DialogDescription>
          </DialogBody>
        )}
        <DialogFooter>
          <Button variant="secondary" size="sm" disabled={pending} onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
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
