/**
 * Wires the chat lane machine into the desktop app.
 * Determines contentOpen from the editor layout and provides controls.
 */
import { useMemo } from "react"
import { useChatLane } from "./use-chat-lane.js"
import type { EditorLayout } from "@jingler/ui"

const hasContentTabs = (layout: EditorLayout): boolean => {
  if (!layout.root) return false
  const allSurfaces = layout.root.type === "group"
    ? layout.root.tabs
    : layout.root.children.flatMap((child) =>
        child.type === "group" ? child.tabs : []
      )
  return allSurfaces.some((surface) => surface.kind !== "chat")
}

export function useChatLaneIntegration(layout: EditorLayout | null) {
  const contentOpen = useMemo(() => layout ? hasContentTabs(layout) : false, [layout])
  return useChatLane(contentOpen)
}
