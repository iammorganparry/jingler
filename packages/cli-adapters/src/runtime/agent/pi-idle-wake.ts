import type { AgentSession } from "@earendil-works/pi-coding-agent"

export interface AgentWake {
  readonly sessionId: string
  readonly chatId: string
}

type WakeListener = (wake: AgentWake) => void
const listeners = new Set<WakeListener>()

/** Main-process fan-out of "this chat has idle results to act on". */
export const agentWakes = {
  publish: (wake: AgentWake): void => {
    for (const listener of listeners) listener(wake)
  },
  subscribe: (listener: WakeListener): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
}

/**
 * Pi starts its own turn when an extension sends a `triggerTurn` message while
 * idle (sub-agent results, control notices). Jingler only streams turns it
 * started, so that turn ran invisibly and its questions resolved to `[]`.
 * Persist the message without a turn instead, and ask the chat to run a real
 * one — the message is already in context when it does.
 */
export const routeIdleTurnsToChat = (
  session: Pick<AgentSession, "sendCustomMessage" | "isStreaming">,
  wake: () => void
): void => {
  const send = session.sendCustomMessage.bind(session)
  session.sendCustomMessage = async (message, options) => {
    if (session.isStreaming || !options?.triggerTurn || options.deliverAs === "nextTurn") {
      return send(message, options)
    }
    await send(message, { ...options, triggerTurn: false })
    wake()
  }
}
