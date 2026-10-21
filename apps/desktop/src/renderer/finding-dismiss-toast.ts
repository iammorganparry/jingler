import type { ToastInput } from "@jingler/ui"

type Listener = (toast: ToastInput) => void
const listeners = new Set<Listener>()

/** App shell subscribes so hooks deep in the tree can raise the "Finding dismissed · Undo" toast. */
export const onFindingDismissToast = (listener: Listener): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const findingDismissedToast = (title: string, undo: () => void): ToastInput => ({
  key: "finding-dismissed",
  variant: "info",
  title: "Finding dismissed",
  description: title,
  action: { label: "Undo", onAction: undo }
})

export const emitFindingDismissed = (title: string, undo: () => void): void => {
  const toast = findingDismissedToast(title, undo)
  for (const listener of listeners) listener(toast)
}
