/**
 * TerminalDockView — binds the app's per-session terminal state (`useTerminals`)
 * and live xterm cells (`XtermView`) to the presentational `TerminalDock` chrome
 * in @jingler/ui. Mounted ONCE (kept alive across session switches) so switching
 * away and back preserves each session's tab strip; dock visibility/side come in
 * as props from `useTerminalDock`.
 */
import { useEffect, useState } from "react"
import type { Session } from "@jingler/core"
import { TerminalDock, type DockSide, type TerminalTab } from "@jingler/ui"
import { useTerminals } from "./use-terminals.js"
import { XtermView } from "./xterm-view.js"

const autoInitializedSessions = new Set<string>()

export interface TerminalDockViewProps {
  /** The active session (its worktree is the terminals' cwd). Null → no session. */
  session: Session | null
  visible?: boolean
  onToggle?: () => void
  side?: DockSide
  onSideChange?: (side: DockSide) => void
  embedded?: boolean
}

export function TerminalDockView({
  session,
  visible = true,
  onToggle = () => {},
  side = "bottom",
  onSideChange = () => {},
  embedded = false
}: TerminalDockViewProps) {
  const cwd = session?.worktreePath ?? undefined
  const terminals = useTerminals(session?.id ?? null, cwd)
  const { create, close, select, markExited, tabs: infos, activeId, hydrated } = terminals

  // Exit code of the most recently exited shell — surfaced in the dock footer.
  const [lastExit, setLastExit] = useState<number | null>(null)

  // First time a session's dock is opened (and its persisted terminals have
  // loaded), spawn one shell if it has none. Tracked per session id so closing
  // the last tab does NOT auto-respawn — the user closed it deliberately.
  useEffect(() => {
    const id = session?.id
    if (!id || !visible || !hydrated || autoInitializedSessions.has(id)) return
    autoInitializedSessions.add(id)
    if (infos.length === 0) void create()
  }, [session?.id, visible, hydrated, infos.length, create])

  const tabs: ReadonlyArray<TerminalTab> = infos.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status
  }))

  return (
    <TerminalDock
      dock={side}
      onDockChange={onSideChange}
      visible={visible}
      onToggle={onToggle}
      tabs={tabs}
      activeId={activeId}
      onSelect={select}
      onNew={() => void create()}
      onClose={(id) => void close(id)}
      cwdLabel={cwd}
      lastExit={lastExit}
      embedded={embedded}
      renderTerminal={(id) => (
        <XtermView
          key={id}
          terminalId={id}
          // Only the visible cell holds a GPU context; hidden tabs (and the
          // whole dock while toggled away) fall back to the DOM renderer.
          active={visible && id === activeId}
          onExit={(code) => {
            markExited(id, code)
            setLastExit(code)
          }}
        />
      )}
    />
  )
}
