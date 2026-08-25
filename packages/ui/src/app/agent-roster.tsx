import type { AgentRosterEntry, PeerAgentMessageResult } from "@jingler/core"
import { MessageSquare, Users } from "lucide-react"
import { useState } from "react"
import { StatusDot } from "../components/status-dot.js"

export function AgentRoster({
  agents,
  currentChatId,
  onMessage
}: {
  readonly agents: ReadonlyArray<AgentRosterEntry>
  readonly currentChatId: string
  readonly onMessage: (chatId: string, text: string) => Promise<PeerAgentMessageResult>
}) {
  const [target, setTarget] = useState<string | null>(null)
  const [text, setText] = useState("")
  const [status, setStatus] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const peers = agents.filter((agent) => agent.chatId !== currentChatId)
  if (peers.length === 0) return null
  return (
    <details className="flex-none border-b border-hairline bg-sunken/40 px-3 py-1 text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-muted-foreground">
        <Users className="size-3" />
        Peer agents
        <span className="text-dim">{peers.length}</span>
      </summary>
      <div className="mt-1.5 grid gap-1.5 pb-1">
        {peers.map((agent) => (
          <div key={agent.chatId} className="rounded-md bg-panel/60 px-2 py-1.5">
            <div className="flex items-center gap-1.5">
              <StatusDot tone={agent.status === "idle" ? "bg-dim" : agent.status === "needs-input" ? "bg-purple" : "bg-yellow"} pulse={agent.status === "running"} size={7} />
              <span className="font-medium text-text-bright">{agent.title}</span>
              <span className="truncate text-dim">{agent.planStage ?? agent.task ?? "Idle"}</span>
              <button type="button" aria-label={`Message ${agent.title}`} onClick={() => setTarget(agent.chatId)} className="ml-auto rounded p-1 text-dim hover:bg-editor hover:text-text">
                <MessageSquare className="size-3" />
              </button>
            </div>
            {agent.touchedFiles.length > 0 && (
              <div className="mt-1 truncate font-mono text-[10px] text-dim">{agent.touchedFiles.join(", ")}</div>
            )}
            {target === agent.chatId && (
              <form className="mt-1.5 flex gap-1" onSubmit={(event) => {
                event.preventDefault()
                if (!text.trim() || sending) return
                setSending(true)
                void onMessage(agent.chatId, text.trim()).then((result) => {
                  setStatus(result.status)
                  if (result.status === "delivered") {
                    setText("")
                    setTarget(null)
                  }
                }).catch(() => setStatus("failed")).finally(() => setSending(false))
              }}>
                <input disabled={sending} aria-label={`Message to ${agent.title}`} value={text} onChange={(event) => setText(event.target.value)} className="min-w-0 flex-1 rounded border border-line bg-editor px-2 py-1 outline-none" />
                <button disabled={sending} type="submit" className="rounded bg-blue px-2 py-1 text-white disabled:opacity-60">Send</button>
              </form>
            )}
          </div>
        ))}
        {status !== null && <span className="text-[10px] text-dim">{status}</span>}
      </div>
    </details>
  )
}
