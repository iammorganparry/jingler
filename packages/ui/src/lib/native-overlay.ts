import { useEffect, useSyncExternalStore } from "react"

/**
 * A registry of DOM overlays that must eclipse NATIVE views.
 *
 * The in-app browser is an Electron `WebContentsView` — an OS-composited
 * surface that always paints above renderer DOM, so no z-index can put a
 * dialog over it. The fix is cooperative: overlays register here while open,
 * and the code that owns a native view subscribes and hides it for as long as
 * anything is registered.
 */
let openOverlays = 0
const listeners = new Set<() => void>()
const notify = () => {
  for (const listener of listeners) listener()
}

/** Register an open overlay; call the returned release exactly once on close. */
export const acquireNativeEclipsingOverlay = (): (() => void) => {
  openOverlays += 1
  notify()
  let released = false
  return () => {
    if (released) return
    released = true
    openOverlays -= 1
    notify()
  }
}

export const subscribeNativeEclipsingOverlays = (
  listener: () => void
): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const snapshot = () => openOverlays > 0

/** Register the calling component as a native-eclipsing overlay while mounted. */
export const useNativeEclipsingOverlay = (): void => {
  useEffect(() => acquireNativeEclipsingOverlay(), [])
}

/** Whether ANY native-eclipsing overlay is currently open. */
export const useHasNativeEclipsingOverlay = (): boolean =>
  useSyncExternalStore(subscribeNativeEclipsingOverlays, snapshot, snapshot)
