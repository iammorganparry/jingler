import { useState } from "react"
import { GitBranch, GitFork } from "lucide-react"
import { cn } from "../lib/cn.js"
import { StatusDot } from "../components/status-dot.js"
import { Button } from "../components/button.js"

/**
 * A direct session's shared checkout drifted off the branch it is pinned to —
 * usually because the agent (or the developer) ran `git switch`. The turn stops
 * because continuing would run against a branch the session's plans and review
 * state do not name.
 *
 * This is the RECOVERY, not an error: the operator either forks the work onto a
 * fresh worktree session on the live branch (default — leaves the primary
 * checkout free to switch back), or adopts the live branch into this session.
 * Both handlers are async; the banner disables itself while one is in flight.
 */
export function BranchDriftBanner({
  pinnedBranch,
  liveBranch,
  onFork,
  onAdopt,
  className
}: {
  pinnedBranch: string
  /** The branch the checkout is on now, or null for a detached HEAD. */
  liveBranch: string | null
  onFork?: () => void | Promise<void>
  onAdopt?: () => void | Promise<void>
  className?: string
}) {
  const [busy, setBusy] = useState<"fork" | "adopt" | null>(null)
  const live = liveBranch ?? "a detached HEAD"
  const run = (which: "fork" | "adopt", handler?: () => void | Promise<void>) => () => {
    if (handler === undefined || busy !== null) return
    const result = handler()
    if (result instanceof Promise) {
      setBusy(which)
      void result.finally(() => setBusy(null))
    }
  }
  // Adopting a detached HEAD has no named branch to pin to, so that path is
  // fork-only — the fork mints a fresh branch off the current commit.
  const canAdopt = liveBranch !== null
  return (
    <div className={cn("overflow-hidden rounded-xl border border-yellow/50 bg-yellow/[0.05]", className)}>
      <div className="flex items-center gap-[9px] border-b border-yellow/20 px-3 py-[9px]">
        <span className="flex size-5 items-center justify-center rounded-md bg-yellow/[0.16] text-yellow">
          <GitBranch size={11} />
        </span>
        <span className="flex-1 text-[12px] font-semibold text-text-bright">
          Checkout moved off <span className="font-mono">{pinnedBranch}</span>
        </span>
        <span className="flex items-center gap-1.5 font-mono text-[10px] text-yellow">
          <StatusDot tone="bg-yellow" size={6} pulse />
          paused
        </span>
      </div>
      <div className="flex flex-col gap-[9px] px-3 py-2.5">
        <span className="text-[12px] leading-[1.5] text-muted-foreground">
          This session is pinned to <span className="font-mono text-text">{pinnedBranch}</span>, but the
          repository is now on <span className="font-mono text-text">{live}</span>. Fork the work onto a
          new worktree session, or adopt the live branch here.
        </span>
        <div className="flex items-center gap-2">
          {canAdopt && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy !== null || onAdopt === undefined}
              onClick={run("adopt", onAdopt)}
            >
              <GitBranch size={12} />
              {busy === "adopt" ? "Adopting…" : `Adopt ${liveBranch}`}
            </Button>
          )}
          <div className="flex-1" />
          <Button
            variant="primary"
            size="sm"
            disabled={busy !== null || onFork === undefined}
            onClick={run("fork", onFork)}
          >
            <GitFork size={12} />
            {busy === "fork" ? "Forking…" : "Fork new session"}
          </Button>
        </div>
      </div>
    </div>
  )
}
