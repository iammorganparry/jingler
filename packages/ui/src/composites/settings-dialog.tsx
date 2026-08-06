import { useEffect, useState } from "react"
import type { GitConfig, GithubConfig, GitHubAppConnectionStatus } from "@jingler/core"
import { GitBranch, RefreshCw, Settings } from "lucide-react"
import { cn } from "../lib/cn.js"
import { GithubMark } from "../components/github-mark.js"
import { Button } from "../components/button.js"
import { StatusDot } from "../components/status-dot.js"
import { Toggle } from "../components/toggle.js"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../components/dialog.js"

const DEFAULT_GITHUB: GithubConfig = { enabled: false, autoCreatePr: false, autoDetectPr: true }
const DEFAULT_GIT: GitConfig = { shareCheckedOutBranches: true }

const sameGithub = (a: GithubConfig, b: GithubConfig): boolean =>
  a.enabled === b.enabled && a.autoCreatePr === b.autoCreatePr && a.autoDetectPr === b.autoDetectPr

const sameGit = (a: GitConfig, b: GitConfig): boolean =>
  a.shareCheckedOutBranches === b.shareCheckedOutBranches

/** One labelled toggle row (label + description on the left, switch on the right). */
function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange
}: {
  label: string
  description: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-start gap-3 py-2.5">
      <div className="flex-1">
        <div className="text-[12.5px] font-medium text-text-body">{label}</div>
        <div className="mt-0.5 text-[11px] leading-[1.5] text-muted-foreground">{description}</div>
      </div>
      <Toggle checked={checked} disabled={disabled} onCheckedChange={onChange} className="mt-0.5" />
    </div>
  )
}

/**
 * Compact Settings dialog for GitHub App connection state and PR preferences.
 */
export function SettingsDialog({
  open,
  connection,
  github,
  git,
  refreshing = false,
  onRefresh,
  onSaveGithub,
  onSaveGit,
  onClose
}: {
  open: boolean
  connection: GitHubAppConnectionStatus
  github?: GithubConfig | null
  git?: GitConfig | null
  refreshing?: boolean
  onRefresh?: () => void
  onSaveGithub?: (config: GithubConfig) => void
  onSaveGit?: (config: GitConfig) => void
  onClose?: () => void
}) {
  const initial = github ?? DEFAULT_GITHUB
  const initialGit = git ?? DEFAULT_GIT
  const [draft, setDraft] = useState<GithubConfig>(initial)
  const [gitDraft, setGitDraft] = useState<GitConfig>(initialGit)

  // Re-seed the form from the persisted config each time the view opens.
  useEffect(() => {
    if (open) {
      setDraft(github ?? DEFAULT_GITHUB)
      setGitDraft(git ?? DEFAULT_GIT)
    }
  }, [open, github, git])

  const activeInstallation = connection.installations.find((installation) => installation.status === "active")
  const suspendedInstallation = connection.installations.find((installation) => installation.status === "suspended")
  const connected = connection.connected && activeInstallation !== undefined
  const githubDirty = !sameGithub(draft, initial)
  const gitDirty = !sameGit(gitDraft, initialGit)
  const dirty = githubDirty || gitDirty

  const save = () => {
    if (githubDirty) onSaveGithub?.(draft)
    if (gitDirty) onSaveGit?.(gitDraft)
    onClose?.()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose?.()}>
      <DialogContent className="w-[520px]">
        <DialogHeader>
          <Settings size={16} className="text-muted-foreground" />
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4 py-4">
          {/* GitHub section */}
          <div className="flex items-center gap-2 border-b border-hairline pb-2.5">
            <GithubMark size={14} className="text-text-bright" />
            <span className="text-[13px] font-semibold text-text-bright">GitHub</span>
          </div>

          {/* Connection status */}
          <div className="flex items-center gap-2.5 rounded-lg border border-line bg-sunken px-3 py-2.5">
            <StatusDot
              tone={connected ? "bg-green" : suspendedInstallation ? "bg-yellow" : "bg-line-strong"}
              size={8}
              glow={connected}
            />
            <div className="flex-1">
              <div className="text-[12.5px] font-medium text-text-body">
                {connected
                  ? `Connected as @${connection.user?.login ?? activeInstallation.account.login}`
                  : suspendedInstallation
                    ? `Installation for @${suspendedInstallation.account.login} is suspended`
                    : "GitHub App not connected"}
              </div>
              {activeInstallation && (
                <div className="mt-0.5 text-[10.5px] text-muted-foreground">
                  @{activeInstallation.account.login} · {activeInstallation.repositorySelection === "all" ? "All repositories" : "Selected repositories"}
                </div>
              )}
            </div>
            {onRefresh && (
              <Button variant="secondary" size="sm" onClick={onRefresh} disabled={refreshing}>
                <RefreshCw size={12} className={cn(refreshing && "animate-spin")} />
                Refresh
              </Button>
            )}
          </div>

          {/* Preferences */}
          <div className="divide-y divide-hairline">
            <ToggleRow
              label="Enable pull-request features"
              description="Show the Pull Request & Code Review tabs and allow posting reviews to GitHub."
              checked={draft.enabled}
              onChange={(enabled) => setDraft((d) => ({ ...d, enabled }))}
            />
            <ToggleRow
              label="Auto-detect pull requests"
              description="Link a PR automatically when one is already open on a session's branch."
              checked={draft.autoDetectPr}
              disabled={!draft.enabled}
              onChange={(autoDetectPr) => setDraft((d) => ({ ...d, autoDetectPr }))}
            />
            <ToggleRow
              label="Auto-create pull requests"
              description="Open a PR automatically once a session's branch has pushable commits."
              checked={draft.autoCreatePr}
              disabled={!draft.enabled}
              onChange={(autoCreatePr) => setDraft((d) => ({ ...d, autoCreatePr }))}
            />
          </div>

          {/* Git section */}
          <div className="mt-1 flex items-center gap-2 border-b border-hairline pb-2.5">
            <GitBranch size={14} className="text-text-bright" />
            <span className="text-[13px] font-semibold text-text-bright">Git</span>
          </div>
          <div className="divide-y divide-hairline">
            <ToggleRow
              label="Open PRs whose branch is checked out elsewhere"
              description="Start a session from a PR even when its branch is already checked out in another worktree (e.g. your main repo). The worktrees then share the branch."
              checked={gitDraft.shareCheckedOutBranches}
              onChange={(shareCheckedOutBranches) => setGitDraft({ shareCheckedOutBranches })}
            />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!dirty} onClick={save}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
