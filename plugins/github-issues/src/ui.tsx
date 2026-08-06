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
import { CheckCircle2, CircleDot, ExternalLink, MessageSquare, Unlink } from "lucide-react"
import {
  definePlugin,
  useHost,
  useSessionActions,
  type TabProps
} from "@jingler/plugin-sdk"
// The themed kit is its own entrypoint, so a plugin's Node-side build scripts
// can import the root without dragging the component library in.
import {
  atLeast,
  Avatar,
  cn,
  githubAvatarUrl,
  // The app's own chip, not a copy. A local port drifted by a font size within
  // one commit, which is the whole argument against porting it.
  IssueLabelChip,
  Markdown,
  relativeTime,
  Spinner,
  useWidthTier
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
  const tier = useWidthTier()
  const [issue, setIssue] = useState<Issue | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [unlinking, setUnlinking] = useState(false)

  const issueNumber = session.issueNumber

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
  }, [host, session.repo, session.worktreePath, issueNumber])

  if (loading && !issue) {
    return (
      <div className="flex flex-1 items-center justify-center bg-editor text-dim">
        <Spinner size={20} />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 bg-editor px-8 text-dim">
        <CircleDot size={24} className="text-line" />
        <span className="text-[13px] text-text">This issue couldn&apos;t be loaded.</span>
        <span className="max-w-[420px] text-center font-mono text-[11.5px] leading-[1.5]">
          {error}
        </span>
      </div>
    )
  }

  if (!issue) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 bg-editor text-dim">
        <CircleDot size={24} className="text-line" />
        <span className="text-[13px]">No issue is linked to this session.</span>
      </div>
    )
  }

  const open = issue.state.toLowerCase() === "open"

  return (
    <div
      data-testid="github-issues-body"
      className="flex min-h-0 flex-1 flex-col overflow-auto bg-editor"
    >
      <div
        className={cn(
          "mx-auto w-full max-w-[820px] py-7",
          atLeast(tier, "mid") ? "px-8" : "px-4"
        )}
      >
        <div className="mb-3 flex flex-wrap items-start gap-x-3 gap-y-2">
          <h1 className="min-w-0 flex-1 text-[22px] font-semibold leading-tight text-text-bright">
            {issue.title}{" "}
            <span className="font-normal text-dim">#{issue.number}</span>
          </h1>
          <button
            type="button"
            onClick={() => void host.openExternal(issue.url)}
            className="flex flex-none items-center gap-1.5 rounded border border-line px-2 py-1 text-[12px] text-text-body transition-colors hover:border-blue hover:text-text-bright"
          >
            <ExternalLink size={12} /> Open on GitHub
          </button>
          <button
            type="button"
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
            className="flex flex-none items-center gap-1.5 rounded border border-line px-2 py-1 text-[12px] text-text-body transition-colors hover:border-red hover:text-text-bright disabled:opacity-50"
          >
            <Unlink size={12} /> {unlinking ? "Unlinking…" : "Unlink"}
          </button>
        </div>

        <div className="mb-5 flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium",
              open ? "bg-green/15 text-green" : "bg-purple/15 text-purple"
            )}
          >
            {open ? <CircleDot size={12} /> : <CheckCircle2 size={12} />}
            {open ? "Open" : "Closed"}
          </span>
          <span className="text-[12px] text-dim">
            {issue.author?.login ?? "unknown"} opened this {relativeTime(issue.createdAt)}
          </span>
          {(issue.comments?.length ?? 0) > 0 && (
            <span className="flex items-center gap-1 text-[12px] text-dim">
              <MessageSquare size={12} /> {issue.comments?.length}
            </span>
          )}
        </div>

        {(issue.labels?.length ?? 0) > 0 && (
          <div className="mb-5 flex flex-wrap gap-1.5">
            {issue.labels?.map((label) => (
              <IssueLabelChip key={label.name} name={label.name} color={label.color} />
            ))}
          </div>
        )}

        <div className="flex flex-col gap-3">
          <Comment
            author={issue.author}
            body={issue.body}
            createdAt={issue.createdAt}
            opening
          />
          {issue.comments?.map((comment, i) => (
            <Comment
              key={`${comment.createdAt}-${i}`}
              author={comment.author}
              body={comment.body}
              createdAt={comment.createdAt}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

export default definePlugin(manifest, {
  views: { "github-issues.issue": IssueTab }
})
