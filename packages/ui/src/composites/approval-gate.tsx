import { useState } from "react"
import { KeyRound, Copy } from "lucide-react"
import type { GateDecision, GateKind, GateStatus } from "@jingler/core"
import { cn } from "../lib/cn.js"
import { StatusDot } from "../components/status-dot.js"
import { Button } from "../components/button.js"
import { Kbd } from "../components/kbd.js"
import { ToolApprovalSurface } from "./beui/work.js"
import { commandLineCount } from "../lib/command-summary.js"

const RESOLVED_LABEL: Record<Exclude<GateStatus, "pending">, string> = {
  approved: "Allowed",
  rejected: "Denied",
  always: "Always allowed"
}

function SwitchToAutoLink({ onClick }: { onClick?: () => void }) {
  if (!onClick) return null
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[12px] leading-[1.33] text-dim underline underline-offset-2 transition-colors hover:text-text"
    >
      Switch session to Auto
    </button>
  )
}

/**
 * The command awaiting approval: a mono, newline-preserving block clamped to ~6 lines
 * with a "Show all · N lines" expand toggle and a copy-to-clipboard button. Kept
 * separate from `ApprovalGate` so its expand/copy state never touches the approve/deny
 * controls below it.
 */
function CommandBlock({ command }: { command: string }) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const lineCount = commandLineCount(command)
  const shouldClamp = !expanded && lineCount > 6

  const handleCopy = () => {
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="relative flex w-full flex-col gap-1.5 rounded-lg border border-line bg-sunken px-2.5 py-2">
      <div
        className={cn(
          "relative pr-6",
          shouldClamp ? "h-24 shrink-0 overflow-clip" : "max-h-[320px] overflow-y-auto"
        )}
      >
        <div className="whitespace-pre-wrap break-all font-mono text-[11px] leading-[1.45] text-text-bright">
          {command}
        </div>
        {shouldClamp && (
          <div aria-hidden className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-b from-transparent to-sunken" />
        )}
      </div>
      {lineCount > 6 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? "Show less" : `Show all · ${lineCount} lines`}
          className="w-max shrink-0 text-[11px] leading-[1.45] text-muted-foreground hover:text-text"
        >
          {expanded ? "Show less" : `Show all · ${lineCount} lines`}
        </button>
      )}
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? "Copied" : "Copy command"}
        title={copied ? "Copied" : "Copy command"}
        className="absolute right-1.5 top-1.5 flex size-[22px] items-center justify-center rounded-[5px] border border-line bg-panel hover:bg-surface"
      >
        <Copy size={12} className="text-muted-foreground" />
      </button>
    </div>
  )
}

/**
 * Human-in-the-loop approval gate — pauses the agent for the operator's call.
 * Renders both the command variant (with the shell command awaiting approval) and
 * the edit variant, and its resolved state once decided. Wired through `onDecide`.
 */
export function ApprovalGate({
  kind,
  title,
  detail,
  command,
  allowLabel,
  status,
  onDecide,
  onSwitchToAuto,
  className
}: {
  kind: GateKind
  title: string
  detail: string
  command?: string | null
  allowLabel?: string | null
  status: GateStatus
  onDecide?: (decision: GateDecision) => void
  onSwitchToAuto?: () => void
  className?: string
}) {
  const pending = status === "pending"

  return (
    <ToolApprovalSurface className={cn("border-line bg-panel", className)}>
      <div className="flex items-center gap-[9px] border-b border-hairline px-3 py-[9px]">
        <span className="flex size-5 items-center justify-center rounded-md bg-surface text-muted-foreground">
          <KeyRound size={11} />
        </span>
        <span className="flex-1 text-[12px] font-semibold text-text-bright">{title}</span>
        {pending ? (
          <span className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
            <StatusDot tone="bg-state-needs" size={6} pulse />
            waiting
          </span>
        ) : (
          <span
            className={cn(
              "font-mono text-[10px]",
              status === "rejected" ? "text-state-failed" : "text-muted-foreground"
            )}
          >
            {RESOLVED_LABEL[status]}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-[9px] px-3 py-2.5">
        {kind === "command" && command && <CommandBlock command={command} />}
        <span className="text-[12px] leading-[1.5] text-muted-foreground">{detail}</span>
        {pending && (
          <>
            <div className="flex items-center gap-2">
              <Button variant="danger" size="sm" onClick={() => onDecide?.("deny")}>
                Deny
                <Kbd>esc</Kbd>
              </Button>
              <div className="flex-1" />
              {allowLabel && (
                <Button variant="secondary" size="sm" onClick={() => onDecide?.("always")}>
                  Always allow <span className="font-mono text-dim">{allowLabel}</span>
                </Button>
              )}
              <Button variant="primary" size="sm" onClick={() => onDecide?.("allow")}>
                Allow once
                <Kbd onFill>⌥↵</Kbd>
              </Button>
            </div>
            <SwitchToAutoLink onClick={onSwitchToAuto} />
          </>
        )}
      </div>
    </ToolApprovalSurface>
  )
}
