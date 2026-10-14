import type { SubagentFleetNode } from "@jingler/core"
import { useState, type ReactNode } from "react"
import { Button } from "../components/button.js"
import { Input } from "../components/input.js"
import { fmtElapsed } from "../lib/relative-time.js"

export interface SubagentReadOnlyBarProps {
  readonly node: SubagentFleetNode
  /** Title of the main chat this subagent belongs to. */
  readonly mainTitle: string
  /** Resolves once the stop request is answered; `acknowledged: false` re-enables Stop. */
  readonly onStop: () => Promise<{ readonly acknowledged: boolean }>
  /** Answer the child's pending request. */
  readonly onReply: (text: string) => void
  /** Restart a terminal child. */
  readonly onRetry: () => void
}

const Shell = ({ testId, children }: { testId: string; children: ReactNode }) => (
  <div
    data-testid={testId}
    className="flex min-w-0 items-center gap-2 whitespace-nowrap rounded-xl border border-line bg-sunken px-3 py-2 text-[12px] text-muted-foreground"
  >
    {children}
  </div>
)
const Line = ({ children }: { children: ReactNode }) => <span className="min-w-0 flex-1 truncate">{children}</span>

function RunningBar({ node, mainTitle, onStop }: Pick<SubagentReadOnlyBarProps, "node" | "mainTitle" | "onStop">) {
  const [stopping, setStopping] = useState(false)
  const stop = () => {
    setStopping(true)
    onStop().then(
      (outcome) => outcome.acknowledged || setStopping(false),
      () => setStopping(false)
    )
  }
  return (
    <Shell testId="subagent-readonly-bar">
      <Line>{stopping ? `Stopping ${node.agent}…` : `Subagent of ${mainTitle} · read-only`}</Line>
      <Button variant="danger" size="sm" disabled={stopping} onClick={stop} className="flex-none">
        Stop
      </Button>
    </Shell>
  )
}

function ReplyBar({ node, onReply }: Pick<SubagentReadOnlyBarProps, "node" | "onReply">) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState("")
  const send = () => {
    if (text.trim() === "") return
    onReply(text.trim())
    setText("")
    setOpen(false)
  }
  return (
    <Shell testId="subagent-readonly-bar">
      {open ? (
        <Input
          autoFocus
          aria-label={`Reply to ${node.agent}`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && send()}
          className="h-8 min-w-0 flex-1 rounded-md px-2 text-[12px]"
        />
      ) : (
        <Line>{node.attention?.message}</Line>
      )}
      <Button variant="secondary" size="sm" onClick={open ? send : () => setOpen(true)} className="flex-none">
        {open ? "Send" : "Reply"}
      </Button>
    </Shell>
  )
}

function SettledBar({ node, onRetry }: Pick<SubagentReadOnlyBarProps, "node" | "onRetry">) {
  const { terminal } = node
  if (terminal === null) return null
  const line =
    terminal.reason === "stopped" ? `Stopped by you · ${fmtElapsed(terminal.at - node.startedAt)}` : terminal.summary
  return (
    <Shell testId="subagent-readonly-bar">
      <Line>{line}</Line>
      {terminal.retryable && (
        <Button variant="secondary" size="sm" onClick={onRetry} className="flex-none">
          Retry
        </Button>
      )}
    </Shell>
  )
}

/** Replaces the composer in a subagent view (board 20b): read-only, with Stop, Reply or Retry by state. */
export function SubagentReadOnlyBar({ node, mainTitle, onStop, onReply, onRetry }: SubagentReadOnlyBarProps) {
  if (node.terminal !== null) return <SettledBar node={node} onRetry={onRetry} />
  if (node.attention !== null) return <ReplyBar node={node} onReply={onReply} />
  return <RunningBar node={node} mainTitle={mainTitle} onStop={onStop} />
}
