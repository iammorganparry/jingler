import type { SidebarUpdateKind } from "@jingler/ui"
import type { UpdateState } from "../shared/update.js"

export interface UpdateRowView {
  readonly version: string
  readonly kind: SidebarUpdateKind
  readonly percent?: number
}

/** Map the updater's published state onto the sidebar row's five visual states. */
export const updateRowView = (state: UpdateState): UpdateRowView => {
  switch (state.status) {
    case "downloading":
      return { version: state.version, kind: "downloading", percent: state.percent }
    case "downloaded":
      return { version: state.version, kind: "downloaded" }
    case "available":
      return {
        version: state.version,
        kind: state.error !== undefined ? "failed" : state.manual === true ? "manual" : "available"
      }
  }
}
