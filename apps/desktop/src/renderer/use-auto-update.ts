import type { SidebarUpdate } from "@jingler/ui"
import { useEffect, useState } from "react"
import type { UpdateState } from "../shared/update.js"

const DISMISSED_UPDATE_KEY = "jingler.dismissed-update-version"

const readDismissedVersion = (): string | null => {
  try {
    return localStorage.getItem(DISMISSED_UPDATE_KEY)
  } catch {
    return null
  }
}

export function useAutoUpdate(): SidebarUpdate | undefined {
  const [state, setState] = useState<UpdateState | null>(null)
  const [dismissedVersion, setDismissedVersion] = useState(readDismissedVersion)

  useEffect(() => {
    let mounted = true
    const unsubscribe = window.jingler.onUpdateState(setState)
    void window.jingler.getUpdateState().then((current) => {
      if (mounted) setState(current)
    }).catch(() => {
      // Development and unpackaged test builds do not register the updater.
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  if (state === null) return undefined

  return {
    ...state,
    dismissed: dismissedVersion === state.version,
    onAction: () => {
      if (state.status === "available") void window.jingler.downloadUpdate()
      if (state.status === "downloaded") void window.jingler.installUpdate()
    },
    onDismiss: () => {
      setDismissedVersion(state.version)
      try {
        localStorage.setItem(DISMISSED_UPDATE_KEY, state.version)
      } catch {
        // The compact button still replaces the card for this session.
      }
    }
  }
}
