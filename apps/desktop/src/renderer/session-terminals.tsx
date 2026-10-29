/**
 * useDesktopSessionTerminals — binds the app's per-session PTY state
 * (`useTerminals`) and live xterm cells (`XtermView`) to the editor: every shell
 * returned here becomes its own `terminal` editor tab in the session pane.
 */
import { useCallback, useMemo } from "react"
import type { Session } from "@jingler/core"
import { activeCheckoutOf } from "@jingler/core"
import type { SessionTerminals } from "@jingler/ui"
import { terminalCwd } from "./subagent-scope.js"
import { useViewedChild } from "./subagent-tab-store.js"
import { useTerminals } from "./use-terminals.js"
import { XtermView } from "./xterm-view.js"

export function useDesktopSessionTerminals(session: Session): SessionTerminals {
  const viewed = useViewedChild(session.id, session.activeChatId)
  // While the lane shows a child with its own worktree, new terminals start there.
  const cwd = terminalCwd(viewed, activeCheckoutOf(session).worktreePath)
  const { create, close, restart, markExited, tabs: infos, hydrated } = useTerminals(session.id, cwd)
  const tabs = useMemo(
    () => infos.map((t) => ({ id: t.id, title: t.title, status: t.status, exitCode: t.exitCode })),
    [infos]
  )
  const renderTerminal = useCallback(
    // Only the visible tab holds a GPU context; hidden tabs stay mounted on the DOM renderer.
    (id: string, visible: boolean) => (
      <XtermView key={id} terminalId={id} active={visible} onExit={(code) => markExited(id, code)} />
    ),
    [markExited]
  )
  return { tabs, hydrated, create, close, restart, cwdLabel: cwd, renderTerminal }
}
