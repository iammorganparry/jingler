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
import { AgentCommandView } from "./agent-command-terminals.js"
import { closeAgentCommand, isAgentCommandTab, useAgentCommandTabs } from "./agent-command-tabs.js"

export function useDesktopSessionTerminals(session: Session): SessionTerminals {
  const viewed = useViewedChild(session.id, session.activeChatId)
  // While the lane shows a child with its own worktree, new terminals start there.
  const cwd = terminalCwd(viewed, activeCheckoutOf(session).worktreePath)
  const { create, close, restart, markExited, tabs: infos, hydrated } = useTerminals(session.id, cwd)
  const agentTabs = useAgentCommandTabs(session.id)
  const tabs = useMemo(
    () => [
      ...infos.map((t) => ({ id: t.id, title: t.title, status: t.status, exitCode: t.exitCode })),
      ...agentTabs.map((t) => ({ id: t.id, title: t.title, status: t.done ? "exited" as const : "running" as const, readOnly: true }))
    ],
    [infos, agentTabs]
  )
  const renderTerminal = useCallback(
    // Only the visible tab holds a GPU context; hidden tabs stay mounted on the DOM renderer.
    (id: string, visible: boolean) => {
      const agentTab = agentTabs.find((t) => t.id === id)
      if (agentTab) return <AgentCommandView key={id} session={session} tab={agentTab} active={visible} />
      return <XtermView key={id} terminalId={id} active={visible} onExit={(code) => markExited(id, code)} />
    },
    [agentTabs, markExited, session]
  )
  const closeTab = useCallback(
    async (id: string) => (isAgentCommandTab(id) ? closeAgentCommand(session.id, id) : close(id)),
    [close, session.id]
  )
  // A mirror has nothing to restart; the agent owns its command.
  const restartTab = useCallback(
    async (id: string) => (isAgentCommandTab(id) ? null : restart(id)),
    [restart]
  )
  return { tabs, hydrated, create, close: closeTab, restart: restartTab, cwdLabel: cwd, renderTerminal }
}
