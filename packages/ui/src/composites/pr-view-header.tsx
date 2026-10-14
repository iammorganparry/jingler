import { useState } from "react"
import type { PrState, PullRequest } from "@jingler/core"
import { Check, Copy, Download } from "lucide-react"
import { relativeTime } from "../lib/relative-time.js"
import { Avatar, githubAvatarUrl } from "../components/avatar.js"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import { DiffStat } from "../components/diff-stat.js"

const STATE_LABEL: Record<PrState, string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" }
const COPIED_MS = 1500

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

/** Copies a branch name; the icon flips to a check for a moment as feedback. */
function CopyBranchButton({ branch }: { branch: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-5 shrink-0"
      aria-label={copied ? "Copied branch name" : "Copy branch name"}
      onClick={() => {
        void navigator.clipboard?.writeText(branch)
        setCopied(true)
        setTimeout(() => setCopied(false), COPIED_MS)
      }}
    >
      {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
    </Button>
  )
}

/**
 * The one-line meta row: state pill · author · `head → base` · commits · files · age.
 * Never wraps (the branch truncates instead) and omits any field the PR lacks.
 */
function PrMetaLine({ pr }: { pr: PullRequest }) {
  const login = pr.author.login
  const age = relativeTime(pr.createdAt)
  return (
    <div
      data-testid="pr-meta-line"
      className="flex min-w-0 items-center gap-x-2.5 overflow-hidden whitespace-nowrap font-mono text-[11.5px] text-muted-foreground"
    >
      <Badge tone="neutral" size="sm">
        {STATE_LABEL[pr.state]}
      </Badge>
      {login && (
        <span className="flex shrink-0 items-center gap-1.5">
          <Avatar initial={login.charAt(0).toUpperCase()} src={githubAvatarUrl(login)} tone="orange" size={16} />
          {login}
        </span>
      )}
      {pr.headRefName && pr.baseRefName && (
        <span className="flex min-w-0 items-center gap-0.5">
          <span className="truncate text-text">
            {pr.headRefName} → {pr.baseRefName}
          </span>
          <CopyBranchButton branch={pr.headRefName} />
        </span>
      )}
      {pr.commits > 0 && <span className="shrink-0">{plural(pr.commits, "commit")}</span>}
      {pr.changedFiles > 0 && <span className="shrink-0">{plural(pr.changedFiles, "file")}</span>}
      <DiffStat added={pr.additions} removed={pr.deletions} className="shrink-0" />
      {age && <span className="shrink-0">{age}</span>}
    </div>
  )
}

export interface PrViewHeaderProps {
  pr: PullRequest
  onOpenSession?: () => void
  sessionActionLabel: string
  sessionActionDisabledReason?: string
  onOpenOnGithub?: () => void
}

/** PR title with a grey `#number`, the actions on the right, and the one-line meta row beneath. */
export function PrViewHeader({
  pr,
  onOpenSession,
  sessionActionLabel,
  sessionActionDisabledReason,
  onOpenOnGithub
}: PrViewHeaderProps) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-start gap-3">
        <h2 className="min-w-0 flex-1 text-pretty text-[20px] font-bold tracking-[-0.2px] text-text-bright">
          {pr.title} <span className="font-normal text-dim">#{pr.number}</span>
        </h2>
        {onOpenSession && (
          <Button
            variant="secondary"
            size="sm"
            disabled={Boolean(sessionActionDisabledReason)}
            title={sessionActionDisabledReason}
            onClick={onOpenSession}
          >
            <Download size={14} aria-hidden />
            {sessionActionLabel}
          </Button>
        )}
        {onOpenOnGithub && (
          <Button variant="ghost" size="sm" onClick={onOpenOnGithub}>
            Open on GitHub ↗
          </Button>
        )}
      </div>
      <PrMetaLine pr={pr} />
    </div>
  )
}
