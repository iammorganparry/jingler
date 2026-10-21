import { expect, it, vi } from "vitest"
import { emitFindingDismissed, onFindingDismissToast } from "./finding-dismiss-toast.js"

it("emits an Undo toast whose action restores the finding", () => {
  const undo = vi.fn()
  const seen = vi.fn()
  const off = onFindingDismissToast(seen)
  emitFindingDismissed("Off by one", undo)
  off()
  const toast = seen.mock.calls[0]?.[0]
  expect(toast.action.label).toBe("Undo")
  toast.action.onAction()
  expect(undo).toHaveBeenCalledOnce()
  emitFindingDismissed("x", undo)
  expect(seen).toHaveBeenCalledOnce()
})
