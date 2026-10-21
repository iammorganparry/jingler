import type { ReactNode } from "react"
import { CircleDot, GitPullRequest, Lock } from "lucide-react"
import { Avatar, githubAvatarUrl } from "../components/avatar.js"
import { BannerShell } from "../components/banner-shell.js"
import { Button } from "../components/button.js"
import { Eyebrow } from "../components/eyebrow.js"
import { EmptyState, InlineError, ListSkeleton } from "../components/feedback.js"
import { GithubMark } from "../components/github-mark.js"
import { IssueLabelChip } from "./issue-picker-list.js"

export interface IssueRailData {
  readonly assignees?: ReadonlyArray<{ readonly login: string }>
  readonly labels?: ReadonlyArray<{ readonly name: string; readonly color?: string }>
  readonly pullRequests?: ReadonlyArray<{ readonly number: number; readonly state: string; readonly url: string }>
  /** The workspace (session) linked to this issue; `onOpen` is omitted when it is already open. */
  readonly workspace?: { readonly title: string; readonly onOpen?: () => void }
  readonly onOpenPullRequest?: (url: string) => void
  readonly provider: string
  readonly repository: string
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2" data-testid={`issue-rail-${title.toLowerCase().replace(/\W+/g, "-")}`}>
      <Eyebrow>{title}</Eyebrow>
      {children}
    </section>
  )
}

/** 280px-rail body for an issue; sections with nothing to show are not rendered. */
export function IssueRail({ assignees = [], labels = [], pullRequests = [], workspace, onOpenPullRequest, provider, repository }: IssueRailData) {
  return (
    <div data-testid="issue-rail" className="flex flex-col gap-4">
      {assignees.length > 0 && (
        <Section title="Assignees">
          {assignees.map((a) => (
            <span key={a.login} className="flex items-center gap-2 text-[12.5px] text-text">
              <Avatar initial={a.login.slice(0, 1).toUpperCase()} src={githubAvatarUrl(a.login)} size={20} />
              {a.login}
            </span>
          ))}
        </Section>
      )}
      {labels.length > 0 && (
        <Section title="Labels">
          <div className="flex flex-nowrap gap-1.5 overflow-hidden">
            {labels.map((l) => <IssueLabelChip key={l.name} name={l.name} color={l.color} />)}
          </div>
        </Section>
      )}
      {workspace && (
        <Section title="Linked workspace">
          <div className="flex items-center gap-2 text-[12.5px] text-text">
            <span className="min-w-0 flex-1 truncate">{workspace.title}</span>
            {workspace.onOpen && <Button variant="secondary" size="sm" onClick={workspace.onOpen}>Open workspace</Button>}
          </div>
        </Section>
      )}
      {pullRequests.length > 0 && (
        <Section title="Linked pull requests">
          {pullRequests.map((pr) => (
            <Button key={pr.url} variant="ghost" size="sm" className="justify-start font-mono" onClick={() => onOpenPullRequest?.(pr.url)}>
              <GitPullRequest size={12} aria-hidden /> #{pr.number} · {pr.state}
            </Button>
          ))}
        </Section>
      )}
      <Section title="Provider">
        <span className="flex items-center gap-2 text-[12.5px] text-text"><GithubMark size={14} /> {provider}</span>
        <span className="font-mono text-[11.5px] text-muted-foreground">{repository}</span>
      </Section>
    </div>
  )
}

export type IssueViewState =
  | { readonly kind: "loading" }
  | { readonly kind: "unlinked"; readonly onLink?: () => void }
  | { readonly kind: "error"; readonly reason: string; readonly onRetry: () => void }

/** Whole-tab states shown instead of the issue. */
export function IssueStateView({ state }: { state: IssueViewState }) {
  return (
    <div data-testid={`issue-state-${state.kind}`} className="flex flex-1 flex-col items-center justify-center bg-editor px-8">
      {state.kind === "loading" && <ListSkeleton rows={4} rowHeight={48} className="w-full max-w-[720px]" />}
      {state.kind === "unlinked" && (
        <EmptyState
          icon={<CircleDot size={24} />}
          title="No issue is linked to this session."
          action={state.onLink && <Button variant="secondary" size="sm" onClick={state.onLink}>Link issue</Button>}
        />
      )}
      {state.kind === "error" && (
        <div className="flex w-full max-w-[520px] flex-col gap-2">
          <span className="text-center text-[13px] text-text">This issue couldn&apos;t be loaded.</span>
          <InlineError message={<span className="font-mono">{state.reason}</span>} onRetry={state.onRetry} />
        </div>
      )}
    </div>
  )
}

/** Neutral banner for a closed issue, with Reopen. */
export function ClosedIssueBanner({ onReopen, reopening = false }: { onReopen: () => void; reopening?: boolean }) {
  return (
    <BannerShell
      icon={<Lock size={14} />}
      placement="card"
      actions={[<Button key="reopen" variant="secondary" size="sm" disabled={reopening} onClick={onReopen}>{reopening ? "Reopening…" : "Reopen"}</Button>]}
    >
      This issue is closed.
    </BannerShell>
  )
}
