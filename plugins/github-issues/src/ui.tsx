/**
 * The Issue tab, rebuilt on the plugin SDK.
 *
 * ## What this file proves
 *
 * It is a port of `IssueView` from `packages/ui/src/composites`, and the port is
 * the point: it uses only what a third-party plugin can reach. No app internals,
 * no `@jingler/ui` deep imports, no privileged data — the session comes from
 * `useSession`, GitHub comes from a host command, and every primitive comes from
 * `@jingler/plugin-sdk`.
 *
 * Writing it is what showed the SDK had no UI kit at all. A rich tab wants
 * markdown, avatars, a spinner and relative timestamps; without those a plugin
 * either bundles a syntax highlighter or hand-rolls flat approximations that
 * drift from the app around them. Both are bad, and neither was obvious until
 * something real had to be built.
 *
 * ## Every colour is a token
 *
 * `text-text-bright`, `bg-panel`, `border-line`, `text-green` — never a hex. A
 * literal colour survives a theme switch unchanged, which on a light theme means
 * white text on white. This tab is correct in all nine bundled themes without
 * having been opened in any of them.
 */
import { useEffect, useState } from "react"
import { ExternalLink, MessageSquare, Unlink } from "lucide-react"
import {
  definePlugin,
  useHost,
  useSessionActions,
  type TabProps
} from "@jingler/plugin-sdk"
// The themed kit is its own entrypoint, so a plugin's Node-side build scripts
// can import the root without dragging the component library in.
import {
  Avatar,
  Badge,
  Button,
  ClosedIssueBanner,
  CommentComposer,
  githubAvatarUrl,
  GithubMark,
  // The app's own chip, not a copy. A local port drifted by a font size within
  // one commit, which is the whole argument against porting it.
  IssueRail,
  IssueStateView,
  Markdown,
  ReadingActionsMenu,
  ReadingShell,
  relativeTime
} from "@jingler/plugin-sdk/ui"
import { manifest } from "./manifest.js"

interface IssueUser {
  readonly login: string
}
interface IssueComment {
  readonly author?: IssueUser
  readonly body: string
  readonly createdAt: string
}
interface Issue {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly state: string
  readonly url: string
  readonly author?: IssueUser
  readonly labels?: ReadonlyArray<{ name: string; color?: string }>
  readonly assignees?: ReadonlyArray<IssueUser>
  readonly comments?: ReadonlyArray<IssueComment>
  readonly createdAt: string
  readonly updatedAt?: string
}

/** One comment, including the issue body rendered as the opening one. */
function Comment({
  author,
  body,
  createdAt,
  opening = false
}: {
  author?: IssueUser
  body: string
  createdAt: string
  opening?: boolean
}) {
  const login = author?.login ?? "unknown"
  return (
    <div className="overflow-hidden rounded-md border border-line">
      <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-2">
        {/* `initial` is required and `src` optional: the monogram is the fallback
            when GitHub's avatar 404s, which it does for deleted accounts. */}
        <Avatar initial={login.slice(0, 1).toUpperCase()} src={githubAvatarUrl(login)} size={20} />
        <span className="text-[12.5px] font-medium text-text">{login}</span>
        <span className="text-[11.5px] text-dim">
          {opening ? "opened this" : "commented"} {relativeTime(createdAt)}
        </span>
      </div>
      <div className="bg-editor px-3 py-3">
        {body.trim().length > 0 ? (
          <Markdown>{body}</Markdown>
        ) : (
          <span className="text-[12.5px] italic text-dim">No description provided.</span>
        )}
      </div>
    </div>
  )
}

function IssueTab({ session }: TabProps) {
  const host = useHost()
  // The built-in Issue tab this replaced offered "unlink", and the first port
  // dropped it — the RPC survived, the button did not, and the operator was left
  // with a session permanently attached to the wrong issue. It comes back
  // through the SDK, the same call any third-party plugin can make.
  const { unlinkIssue } = useSessionActions()
  const [issue, setIssue] = useState<Issue | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [unlinking, setUnlinking] = useState(false)
  const [closing, setClosing] = useState(false)
  const [reopening, setReopening] = useState(false)
  const [reloads, setReloads] = useState(0)

  const linkedIssue = session.linkedIssue
  const issueNumber =
    linkedIssue?.providerId === "github" ? Number(linkedIssue.id) : undefined

  useEffect(() => {
    if (issueNumber == null) return
    let cancelled = false
    setLoading(true)
    setError(null)

    void host
      .invoke<Issue>("github-issues.fetch", {
        repo: session.repo,
        issueNumber,
        worktreePath: session.worktreePath
      })
      .then((next) => {
        if (!cancelled) setIssue(next)
      })
      .catch((cause: unknown) => {
        // Shown rather than swallowed. A declined consent prompt and a GitHub
        // 404 are different states, and an empty tab makes them look identical.
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [host, session.repo, session.worktreePath, issueNumber, reloads])

  if (loading && !issue) return <IssueStateView state={{ kind: "loading" }} />
  if (error) {
    return <IssueStateView state={{ kind: "error", reason: error, onRetry: () => setReloads((n) => n + 1) }} />
  }
  // No `onLink`: the SDK has no action that opens the link picker, so the button is hidden.
  if (!issue) return <IssueStateView state={{ kind: "unlinked" }} />

  const reference = { repo: session.repo, issueNumber, worktreePath: session.worktreePath }
  const open = issue.state === "open"

  return (
    <ReadingShell
      title={issue.title}
      identifier={`#${issue.number}`}
      meta={<IssueMetaLine issue={issue} />}
      rail={
        <IssueRail
          assignees={issue.assignees}
          labels={issue.labels}
          workspace={{ title: session.title }}
          provider="GitHub"
          repository={session.repo}
        />
      }
      actions={
        <>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void host.openExternal(issue.url)}
          >
            <ExternalLink size={14} aria-hidden /> Open on GitHub
          </Button>
          <Button
            variant="secondary"
            size="sm"
            data-testid="github-issues-unlink"
            disabled={unlinking}
            onClick={() => {
              // NOT optimistic. An earlier version cleared `issue` first and
              // fired the call with `void`, which fails in two ways at once if
              // the RPC rejects: the rejection is unhandled, and the tab sits
              // there claiming no issue is linked while the session still has
              // one — a lie the operator can only discover by restarting.
              //
              // The RPC is fast and local, so waiting costs a frame. The button
              // disables meanwhile so it cannot be double-fired.
              setUnlinking(true)
              void unlinkIssue(session.id)
                .then(() => {
                  // Cleared only on success. The session record updates through
                  // `session-updates`, but this component's `issue` is its own
                  // state — without this the detached issue stays on screen
                  // until something else re-renders the tab.
                  setIssue(null)
                })
                .catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : String(cause))
                })
                .finally(() => {
                  setUnlinking(false)
                })
            }}
          >
            <Unlink size={14} aria-hidden /> {unlinking ? "Unlinking…" : "Unlink"}
          </Button>
          <ReadingActionsMenu
            items={[
              { label: "Copy link", onSelect: () => void navigator.clipboard?.writeText(issue.url) },
              ...(open
                ? [
                    {
                      label: closing ? "Closing…" : "Close issue",
                      destructive: true,
                      disabled: closing,
                      onSelect: () => {
                        setClosing(true)
                        void host
                          .invoke("github-issues.close", reference)
                          .then(() => setIssue({ ...issue, state: "closed" }))
                          .catch((cause: unknown) => {
                            setError(cause instanceof Error ? cause.message : String(cause))
                          })
                          .finally(() => setClosing(false))
                      }
                    }
                  ]
                : [])
            ]}
          />
        </>
      }
    >
      <div data-testid="github-issues-body" className="flex flex-col gap-[18px]">
        {!open && (
          <ClosedIssueBanner
            reopening={reopening}
            onReopen={() => {
              setReopening(true)
              void host
                .invoke("github-issues.reopen", reference)
                .then(() => setIssue({ ...issue, state: "open" }))
                .catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : String(cause))
                })
                .finally(() => setReopening(false))
            }}
          />
        )}

        <div className="flex flex-col gap-3">
          <Comment author={issue.author} body={issue.body} createdAt={issue.createdAt} opening />
          {issue.comments?.map((comment, i) => (
            <Comment
              key={`${comment.createdAt}-${i}`}
              author={comment.author}
              body={comment.body}
              createdAt={comment.createdAt}
            />
          ))}
        </div>

        <CommentComposer
          // Remounted per issue so a draft never crosses to another one.
          key={issue.number}
          canClose={open}
          post={async (body, close) => {
            await host.invoke("github-issues.comment", { ...reference, body, close })
            // The post already succeeded; if the refresh fails, show the comment locally
            // rather than reject and invite a duplicate post.
            const next = await host.invoke<Issue>("github-issues.fetch", reference).catch(() => ({
              ...issue,
              state: close ? "closed" : issue.state,
              comments: [...(issue.comments ?? []), { body, createdAt: new Date().toISOString() }]
            }))
            setIssue(next)
          }}
        />
      </div>
    </ReadingShell>
  )
}

export default definePlugin(manifest, {
  views: { "github-issues.issue": IssueTab }
})

/** Provider logo · state pill · author · relative `updatedAt` · comment count. */
function IssueMetaLine({ issue }: { readonly issue: Issue }) {
  const open = issue.state === "open"
  const login = issue.author?.login
  const commentCount = issue.comments?.length ?? 0
  return (
    <div
      data-testid="issue-meta-line"
      className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[11.5px] text-muted-foreground"
    >
      <GithubMark size={14} />
      <Badge tone={open ? "green" : "purple"} size="sm">
        {open ? "Open" : "Closed"}
      </Badge>
      {login && (
        <span className="flex shrink-0 items-center gap-1.5">
          <Avatar initial={login.slice(0, 1).toUpperCase()} src={githubAvatarUrl(login)} size={16} />
          {login}
        </span>
      )}
      <span className="shrink-0">updated {relativeTime(issue.updatedAt ?? issue.createdAt)}</span>
      {commentCount > 0 && (
        <span className="flex shrink-0 items-center gap-1">
          <MessageSquare size={12} aria-hidden /> {commentCount}
        </span>
      )}
    </div>
  )
}
