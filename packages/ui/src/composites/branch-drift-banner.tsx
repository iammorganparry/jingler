import { useState } from "react"
import { GitBranch, GitFork } from "lucide-react"
import { BannerShell } from "../components/banner-shell.js"
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
      result.then(
        () => setBusy(null),
        () => setBusy(null)
      )
    }
  }
  // Adopting a detached HEAD has no named branch to pin to, so that path is
  // fork-only — the fork mints a fresh branch off the current commit.
  const canAdopt = liveBranch !== null
  const adopt = canAdopt && (
    <Button
      key="adopt"
      variant="secondary"
      size="sm"
      disabled={busy !== null || onAdopt === undefined}
      onClick={run("adopt", onAdopt)}
    >
      <GitBranch size={12} />
      {busy === "adopt" ? "Adopting…" : `Adopt ${liveBranch}`}
    </Button>
  )
  const fork = (
    <Button
      key="fork"
      variant="primary"
      size="sm"
      disabled={busy !== null || onFork === undefined}
      onClick={run("fork", onFork)}
    >
      <GitFork size={12} />
      {busy === "fork" ? "Forking…" : "Fork new session"}
    </Button>
  )
  return (
    <BannerShell
      placement="card"
      className={className}
      icon={<GitBranch size={13} />}
      actions={adopt ? [adopt, fork] : [fork]}
    >
      Checkout moved off <span className="font-mono">{pinnedBranch}</span> — the repository is now on{" "}
      <span className="font-mono">{live}</span>
    </BannerShell>
  )
}
