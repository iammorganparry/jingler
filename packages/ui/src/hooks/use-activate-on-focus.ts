import { useEffect } from "react"

/** Call `onActivate` on mount, window focus, and when the document becomes visible. */
export function useActivateOnFocus(onActivate?: () => void) {
  useEffect(() => {
    if (!onActivate) return
    // Wrapped so listeners never forward their event as an argument.
    const activate = () => onActivate()
    const onVisible = () => { if (document.visibilityState === "visible") activate() }
    activate()
    window.addEventListener("focus", activate)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      window.removeEventListener("focus", activate)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [onActivate])
}
