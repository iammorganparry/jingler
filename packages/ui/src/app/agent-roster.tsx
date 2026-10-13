import type { AgentRosterEntry, PeerAgentMessageResult } from "@jingler/core"
import { useState } from "react"
import { Button } from "../components/button.js"
import { Input } from "../components/input.js"
import { StatusDot } from "../components/status-dot.js"

/**
 * One peer agent in the SubagentChip popover's `Peers · N` section: status, task,
 * touched files, and a ghost `Message` button that reveals an inline send box.
 */
export function PeerAgentRow({
  agent,
  onMessage
}: {
  readonly agent: AgentRosterEntry
  readonly onMessage: (chatId: string, text: string) => Promise<PeerAgentMessageResult>
}) {
  const [composing, setComposing] = useState(false)
  const [text, setText] = useState("")
  const [status, setStatus] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const send = () => {
    if (!text.trim() || sending) return
    setSending(true)
    setStatus(null)
    void onMessage(agent.chatId, text.trim()).then((result) => {
      setStatus(result.status)
      if (result.status === "delivered") {
        setText("")
        setComposing(false)
      }
    }).catch(() => setStatus("failed")).finally(() => setSending(false))
  }
  return (
    <div data-testid={`peer-agent-row-${agent.chatId}`} className="rounded-md px-2.5 py-2 text-[12.5px]">
      <div className="flex items-center gap-2">
        <StatusDot tone={agent.status === "idle" ? "bg-dim" : "bg-muted-foreground"} pulse={agent.status === "running"} size={7} />
        <span className="flex-none font-medium text-text-bright">{agent.title}</span>
        <span className="min-w-0 flex-1 truncate text-dim">
          {agent.status === "needs-input" ? "needs you" : agent.planStage ?? agent.task ?? "Idle"}
        </span>
        <Button type="button" variant="ghost" size="sm" aria-label={`Message ${agent.title}`} className="flex-none px-2" onClick={() => setComposing(true)}>
          Message
        </Button>
      </div>
      {agent.touchedFiles.length > 0 && (
        <div className="mt-1 truncate font-mono text-[10px] text-dim">{agent.touchedFiles.join(", ")}</div>
      )}
      {composing && (
        <form className="mt-1.5 flex gap-1" onSubmit={(event) => {
          event.preventDefault()
          send()
        }}>
          {/* Keystrokes must not reach the menu's typeahead, which would steal focus. */}
          <Input
            autoFocus
            disabled={sending}
            aria-label={`Message to ${agent.title}`}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
            className="h-8 min-w-0 flex-1 rounded-md px-2 text-xs"
          />
          <Button disabled={sending} type="submit" variant="primary" size="sm">Send</Button>
        </form>
      )}
      {status === "failed" && composing && (
        <span className="mt-1 flex items-center gap-1 text-[10px] text-dim">
          Not delivered ·
          <Button type="button" variant="ghost" size="sm" disabled={sending} onClick={send}>Retry</Button>
        </span>
      )}
    </div>
  )
}
