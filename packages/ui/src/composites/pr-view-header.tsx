import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { useState, type ReactNode } from "react"
import type { PrState, PullRequest } from "@jingler/core"
import { Check, Copy, Download, Ellipsis, ExternalLink } from "lucide-react"
import { relativeTime } from "../lib/relative-time.js"
import { Avatar, githubAvatarUrl } from "../components/avatar.js"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import { DiffStat } from "../components/diff-stat.js"
import { Tooltip } from "../components/tooltip.js"
import { cn } from "../lib/cn.js"

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
      {pr.state !== "draft" && (
        <Badge tone="neutral" size="sm">
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

export const menuItemClass =
  "flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[12.5px] text-text-body outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface data-[highlighted]:text-text-bright"

/** The `⋯` menu: Mark ready (drafts), Copy branch, Close PR (destructive, confirmed by the caller). */
function PrActionsMenu({
  pr,
  onMarkReady,
  markingReady,
  onRequestClose
}: Pick<PrViewHeaderProps, "pr" | "onMarkReady" | "markingReady" | "onRequestClose">) {
  const canMarkReady = Boolean(onMarkReady) && pr.state === "draft"
  const canClose = Boolean(onRequestClose) && (pr.state === "open" || pr.state === "draft")
  if (!canMarkReady && !canClose && !pr.headRefName) return null
  return (
    <DropdownMenu.Root>
      <Tooltip label="More actions" side="bottom">
        <DropdownMenu.Trigger asChild>
          <Button variant="ghost" size="icon" aria-label="More actions" className="size-7">
            <Ellipsis size={16} aria-hidden />
          </Button>
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 flex min-w-[180px] flex-col gap-0.5 rounded-lg border border-line bg-sunken p-1.5 shadow-2xl"
        >
          {canMarkReady && (
            <DropdownMenu.Item disabled={markingReady} onSelect={() => onMarkReady?.()} className={menuItemClass}>
              {markingReady ? "Marking ready…" : "Mark ready"}
            </DropdownMenu.Item>
          )}
          {pr.headRefName && (
            <DropdownMenu.Item onSelect={() => void navigator.clipboard?.writeText(pr.headRefName)} className={menuItemClass}>
              Copy branch
            </DropdownMenu.Item>
          )}
          {canClose && (
            <DropdownMenu.Item onSelect={() => onRequestClose?.()} className={cn(menuItemClass, "text-state-failed")}>
              Close PR
            </DropdownMenu.Item>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
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
  switcher
}: PrViewHeaderProps) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-start gap-3">
        <h2 className="min-w-0 flex-1 text-pretty text-[20px] font-bold tracking-[-0.2px] text-text-bright">
          {pr.title} <span className="font-normal text-dim">#{pr.number}</span>
          {pr.state === "draft" && (
            <Badge tone="neutral" size="sm" className="ml-2 align-middle" title="Draft pull request">
              Draft
            </Badge>
          )}
        </h2>
        {switcher}
        {onOpenOnGithub && (
          <Tooltip label="Open on GitHub" side="bottom">
            <Button variant="ghost" size="icon" aria-label="Open on GitHub" className="size-7" onClick={onOpenOnGithub}>
              <ExternalLink size={15} aria-hidden />
            </Button>
          </Tooltip>
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
      </div>
      <PrMetaLine pr={pr} />
    </div>
  )
}
