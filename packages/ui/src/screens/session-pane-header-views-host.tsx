import { BUILTIN_TAB } from "../app/tab-contributions.js"
import { SessionPane, type SessionPaneProps } from "./session-pane.js"

/** Test host: SessionPane plus the title-bar slot, with every view pinned so tests open views through the header buttons. */
export function SessionPaneWithHeaderViews(props: SessionPaneProps) {
  const ids = [...Object.values(BUILTIN_TAB).map((id) => (id === BUILTIN_TAB.pr ? "checks" : id)), ...(props.tabContributions ?? []).map((c) => c.id)]
  return (
    <>
      <div id="session-header-views-portal" />
      <SessionPane headerViews={ids} onHeaderViewsChange={() => {}} {...props} />
    </>
  )
}
