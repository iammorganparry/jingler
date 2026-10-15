import { useCallback, useMemo, useRef, type ReactNode } from "react"
import { useSelector } from "@xstate/react"
import type { Session } from "@jingler/core"
import { agentEditsOf, AgentEditsMarker, jumpToTurn, type AgentEdit } from "@jingler/ui"
import { getConversationActor } from "./conversation-registry.js"

const sameEdits = (a: readonly AgentEdit[], b: readonly AgentEdit[]): boolean =>
  a.length === b.length &&
  a.every((edit, i) => edit.id === b[i]!.id && edit.turnId === b[i]!.turnId && edit.preview === b[i]!.preview)

/** The active chat's agent edits to `path`; identity is stable while streaming doesn't change them. */
export function useAgentEdits(session: Session, path: string | null): readonly AgentEdit[] {
  // Memoised: getConversationActor pushes the session into the actor on every call.
  const actor = useMemo(() => getConversationActor(session), [session.id, session.activeChatId]) // eslint-disable-line react-hooks/exhaustive-deps
  const messages = useSelector(actor, (snapshot) => snapshot.context.messages)
  const edits = useMemo(() => (path === null ? [] : agentEditsOf(messages, path)), [messages, path])
  const stable = useRef(edits)
  if (!sameEdits(stable.current, edits)) stable.current = edits
  return stable.current
}

/** Clicking an `Agent edit · Turn N` label scrolls the active chat's transcript to that turn. */
export const useJumpToAgentEditTurn = (session: Session): ((turnId: string) => void) =>
  useCallback((turnId: string) => jumpToTurn(session.activeChatId, turnId), [session.activeChatId])

function FileAgentEditsMarker({ session, path }: { readonly session: Session; readonly path: string }) {
  return <AgentEditsMarker count={useAgentEdits(session, path).length} />
}

/** Renders the breadcrumb's `● N agent edits` for a file tab of any session. */
export const useAgentEditsMarkerRenderer = (
  sessions: ReadonlyArray<Session>
): ((sessionId: string, path: string) => ReactNode) =>
  useCallback(
    (sessionId, path) => {
      const session = sessions.find((candidate) => candidate.id === sessionId)
      return session === undefined ? null : <FileAgentEditsMarker session={session} path={path} />
    },
    [sessions]
  )
