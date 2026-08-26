import { type ReactNode, useEffect, useRef, useState } from "react"
import { TriangleAlert } from "lucide-react"
import { Loader } from "./beui/loader.js"
import { Button } from "./button.js"
import { cn } from "../lib/cn.js"

type AsyncState = "idle" | "pending" | "success" | "error"

const SUCCESS = "bg-green text-white"

/** An animated "draw-in" check mark (design's success state). */
function CheckDraw() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="flex-none">
      <path
        d="M20 6L9 17l-5-5"
        stroke="currentColor"
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={22}
        className="animate-check"
      />
    </svg>
  )
}

/**
 * A button for async / agent actions with built-in feedback:
 * idle → pending (spinner + disabled) → success (green + check draw) → auto-reset
 * after 1.6s; a failure shakes once and shows a retry label. Set `terminal` (or
 * `done`) to hold the success state so the action can't be re-fired — used for
 * "Send to agent" so a comment isn't sent twice. The width is locked on first run
 * so the row never reflows between states.
 */
export function AsyncButton({
  children,
  pendingLabel,
  successLabel = "Done",
  errorLabel = "Failed — retry",
  doneLabel,
  onClick,
  variant = "primary",
  terminal = false,
  done = false,
  disabled = false,
  icon,
  size = "sm",
  className
}: {
  children: ReactNode
  /** Label while the promise is pending (defaults to the idle label). */
  pendingLabel?: ReactNode
  successLabel?: ReactNode
  errorLabel?: ReactNode
  /** Label shown when held in the terminal `done` state (defaults to successLabel). */
  doneLabel?: ReactNode
  onClick: () => Promise<void> | void
  variant?: "primary" | "secondary" | "danger"
  /** Hold the success state after completing (no reset) — the action can't re-fire. */
  terminal?: boolean
  /** Externally-controlled terminal success (already done, e.g. persisted "sent"). */
  done?: boolean
  disabled?: boolean
  icon?: ReactNode
  size?: "sm" | "md"
  className?: string
}) {
  const [state, setState] = useState<AsyncState>("idle")
  const ref = useRef<HTMLButtonElement>(null)
  const [minW, setMinW] = useState<number>()
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  const effective: AsyncState = done ? "success" : state
  const held = terminal || done // stays in success (no resend)
  const locked = effective !== "idle" || disabled

  const run = () => {
    if (locked) return
    if (ref.current) setMinW(ref.current.offsetWidth)
    setState("pending")
    Promise.resolve()
      .then(() => onClick())
      .then(() => {
        setState("success")
        if (!terminal) timer.current = setTimeout(() => setState("idle"), 1600)
      })
      .catch(() => {
        setState("error")
        timer.current = setTimeout(() => setState("idle"), 1100)
      })
  }

  const tone =
    effective === "success"
      ? SUCCESS
      : effective === "error"
        ? "animate-shake"
        : undefined

  return (
    <Button
      ref={ref}
      variant={variant}
      size={size}
      disabled={locked}
      onClick={run}
      style={minW ? { minWidth: minW } : undefined}
      className={cn(tone, className)}
    >
      {effective === "pending" ? (
        <>
          <Loader size={13} label="Working" />
          {pendingLabel ?? children}
        </>
      ) : effective === "success" ? (
        <>
          <CheckDraw />
          {held ? (doneLabel ?? successLabel) : successLabel}
        </>
      ) : effective === "error" ? (
        <>
          <TriangleAlert size={14} />
          {errorLabel}
        </>
      ) : (
        <>
          {icon}
          {children}
        </>
      )}
    </Button>
  )
}
