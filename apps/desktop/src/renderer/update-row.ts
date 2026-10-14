import type { SidebarUpdateKind } from "@jingler/ui"
import type { UpdateState } from "../shared/update.js"

export interface UpdateRowView {
  readonly version: string
  readonly kind: SidebarUpdateKind
  readonly percent?: number
  readonly detail?: string
}

const MANUAL_DETAIL = "This build can't update itself. Open the installer and drag Jingler into Applications."


/** Map the updater's published state onto the sidebar row's five visual states. */
export const updateRowView = (state: UpdateState): UpdateRowView => {
  switch (state.status) {
    case "downloading":
      return { version: state.version, kind: "downloading", percent: state.percent }
    case "downloaded":
      return { version: state.version, kind: "downloaded" }
    case "available":
      if (state.error !== undefined) return { version: state.version, kind: "failed", detail: state.error }
      if (state.manual === true) return { version: state.version, kind: "manual", detail: MANUAL_DETAIL }
      return { version: state.version, kind: "available" }
  }
}
