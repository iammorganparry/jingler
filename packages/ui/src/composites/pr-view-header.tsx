import { useState, type ReactNode } from "react"
import type { PrState, PullRequest } from "@jingler/core"
import { Check, Copy, Download, ExternalLink } from "lucide-react"
import { relativeTime } from "../lib/relative-time.js"
import { Avatar, githubAvatarUrl } from "../components/avatar.js"
import { Badge, type BadgeTone } from "../components/badge.js"
import { Button } from "../components/button.js"
import { DiffStat } from "../components/diff-stat.js"
import { ReadingActionsMenu, ReadingHeader, type ReadingMenuItem } from "../components/reading-shell.js"
import { Tooltip } from "../components/tooltip.js"

const STATE_LABEL: Record<PrState, string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" }
const STATE_TONE: Record<PrState, BadgeTone> = { open: "neutral", draft: "neutral", merged: "purple", closed: "red" }
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
      {pr.state !== "draft" && (
        <Badge tone={STATE_TONE[pr.state]} size="sm">
          {STATE_LABEL[pr.state]}
        </Badge>
      )}
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

/** The `⋯` menu: Mark ready (drafts), Copy branch, Close PR (destructive, confirmed by the caller). */
function PrActionsMenu({
  pr,
  onMarkReady,
  markingReady,
  onRequestClose
}: Pick<PrViewHeaderProps, "pr" | "onMarkReady" | "markingReady" | "onRequestClose">) {
  const items: ReadingMenuItem[] = []
  if (onMarkReady && pr.state === "draft") {
    items.push({ label: markingReady ? "Marking ready…" : "Mark ready", disabled: markingReady, onSelect: onMarkReady })
  }
  if (pr.headRefName) {
    items.push({ label: "Copy branch", onSelect: () => void navigator.clipboard?.writeText(pr.headRefName) })
  }
  if (onRequestClose && (pr.state === "open" || pr.state === "draft")) {
    items.push({ label: "Close PR", destructive: true, onSelect: onRequestClose })
  }
  return <ReadingActionsMenu items={items} />
}

export interface PrViewHeaderProps {
  pr: PullRequest
  onOpenSession?: () => void
  sessionActionLabel: string
  sessionActionDisabledReason?: string
  onOpenOnGithub?: () => void
  onMarkReady?: () => void
  markingReady?: boolean
  /** Ask to close the PR; the parent owns the ConfirmDialog. */
  onRequestClose?: () => void
  /** Opens the review drawer (⌘⇧R); present only on PRs opened from the sidebar inbox. */
  onReview?: () => void
  /** The stack switcher, shown beside the title when the session has a PR stack. */
  switcher?: ReactNode
}

/** PR title with a grey `#number`, the actions on the right, and the one-line meta row beneath. */
export function PrViewHeader({
  pr,
  onOpenSession,
  sessionActionLabel,
  sessionActionDisabledReason,
  onOpenOnGithub,
  onMarkReady,
  markingReady,
  onRequestClose,
  onReview,
  switcher
}: PrViewHeaderProps) {
  return (
    <ReadingHeader
      title={pr.title}
      identifier={`#${pr.number}`}
      titleAdornment={
        pr.state === "draft" && (
          <Badge tone="neutral" size="sm" className="ml-2 align-middle" title="Draft pull request">
            Draft
          </Badge>
        )
      }
      meta={<PrMetaLine pr={pr} />}
      actions={
        <>
          {switcher}
          {onOpenOnGithub && (
            <Tooltip label="Open on GitHub" side="bottom">
              <Button variant="ghost" size="icon" aria-label="Open on GitHub" className="size-7" onClick={onOpenOnGithub}>
                <ExternalLink size={15} aria-hidden />
              </Button>
            </Tooltip>
          )}
          {onReview && (
            <Tooltip label="Review" shortcut="mod+shift+r" side="bottom">
              <Button variant="secondary" size="sm" onClick={onReview}>Review</Button>
            </Tooltip>
          )}
          {onMarkReady && pr.state === "draft" && (
            <Button variant="secondary" size="sm" disabled={markingReady} onClick={onMarkReady}>
              {markingReady ? "Marking ready…" : "Mark ready for review"}
            </Button>
          )}
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
          <PrActionsMenu pr={pr} onMarkReady={onMarkReady} markingReady={markingReady} onRequestClose={onRequestClose} />
        </>
      }
    />
  )
}
