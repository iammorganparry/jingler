import { useMachine } from "@xstate/react"
import {
  definePlugin,
  type IssueComment,
  type IssueIdentity,
  type IssueReference,
  type IssueSummary,
  type SessionSnapshot,
  type TabProps,
  useHost,
  useSessionActions
} from "@jingler/plugin-sdk"
import {
  atLeast,
  Avatar,
  cn,
  IssueLabelChip,
  Markdown,
  relativeTime,
  Spinner,
  useWidthTier
} from "@jingler/plugin-sdk/ui"
import {
  AlertCircle,
  ExternalLink,
  Link2,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Trash2,
  Unlink,
  X
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import type { ActorRefFrom, SnapshotFrom } from "xstate"
import {
  linearIssueMachine,
  type LinearIssueDetail,
  type LinearIssueServices,
  type LinearWorkspaceContext
} from "./linear-issue-machine.js"
import { manifest } from "./manifest.js"
import type { LinearConfiguration, LinearSelection } from "./types.js"

type LinearIssueSnapshot = SnapshotFrom<typeof linearIssueMachine>
type LinearIssueSend = ActorRefFrom<typeof linearIssueMachine>["send"]
const LINEAR_MARK_URL = `jingler-plugin://${manifest.id}/dist/assets/linear-mark.svg?v=${encodeURIComponent(manifest.version)}`

interface HostRepository {
  readonly name: string
  readonly path: string
}

function linearServices(
  host: ReturnType<typeof useHost>,
  session: SessionSnapshot,
  linkIssue: (sessionId: string, issue: IssueReference) => Promise<void>,
  removeIssue: (sessionId: string, issue: IssueIdentity) => Promise<void>
): LinearIssueServices {
  const repository: HostRepository = {
    name: session.repo,
    path: session.worktreePath ?? ""
  }
  const route = { sessionId: session.id, repository }
  const accountRoute = (providerAccountId: string | undefined) => {
    if (providerAccountId === undefined) return route
    return { ...route, profileId: providerAccountId }
  }
  return {
    configured: () => host.invoke<boolean>("linear.configured", route),
    context: () => host.invoke<LinearWorkspaceContext>("linear.context", route),
    list: (search) =>
      host.invoke<readonly IssueSummary[]>("linear.list", { ...route, search, mine: false }),
    get: async (issueId) => {
      const providerAccountId = session.linkedIssues?.find(
        (issue) => issue.providerId === "linear" && issue.id === issueId
      )?.providerAccountId
      const issue = await host.invoke<LinearIssueDetail | null>("linear.get", {
        ...accountRoute(providerAccountId),
        issueId
      })
      if (!issue) throw new Error("Linear could not find this issue.")
      return issue
    },
    create: (input) =>
      host.invoke<LinearIssueDetail>("linear.create", {
        ...route,
        title: input.title.trim(),
        body: input.description?.trim() ?? "",
        teamId: input.teamId
      }),
    comment: async (issueId, body) => {
      const providerAccountId = session.linkedIssues?.find(
        (issue) => issue.providerId === "linear" && issue.id === issueId
      )?.providerAccountId
      await host.invoke<IssueComment>("linear.comment", {
        ...accountRoute(providerAccountId),
        issueId,
        body
      })
    },
    link: (issue) => linkIssue(session.id, issue),
    unlink: async () => {
      const issue = session.linkedIssue
      if (issue?.providerId !== "linear") {
        throw new Error("No selected Linear issue to unlink.")
      }
      const identity: IssueIdentity = {
        providerId: issue.providerId,
        id: issue.id
      }
      await removeIssue(session.id, identity)
    }
  }
}

function LinearMark({ className }: { readonly className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block flex-none bg-current", className)}
      data-linear-mark="true"
      style={{
        mask: `url("${LINEAR_MARK_URL}") center / contain no-repeat`,
        WebkitMask: `url("${LINEAR_MARK_URL}") center / contain no-repeat`
      }}
    />
  )
}

function ErrorNotice({ message }: { readonly message: string }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded border border-red/40 bg-red/10 px-3 py-2 text-[12px] text-text">
      <AlertCircle size={14} className="mt-0.5 flex-none text-red" />
      <span>{message}</span>
    </div>
  )
}

function Comment({ comment }: { readonly comment: IssueComment }) {
  const author = comment.author?.name ?? "Deleted user"
  return (
    <article className="overflow-hidden rounded-md border border-line">
      <header className="flex items-center gap-2 border-b border-line bg-panel px-3 py-2">
        <Avatar
          initial={author.slice(0, 1).toUpperCase()}
          src={comment.author?.avatarUrl ?? undefined}
          size={20}
        />
        <span className="text-[12px] font-medium text-text">{author}</span>
        <span className="text-[11px] text-dim">commented {relativeTime(comment.createdAt)}</span>
      </header>
      <div className="bg-editor px-3 py-3">
        <Markdown>{comment.body}</Markdown>
      </div>
    </article>
  )
}

function UnlinkedView({
  snapshot,
  send
}: {
  readonly snapshot: LinearIssueSnapshot
  readonly send: LinearIssueSend
}) {
  const { context } = snapshot
  const tier = useWidthTier()
  return (
    <div className={cn("grid gap-6", atLeast(tier, "wide") && "grid-cols-2")}>
      {context.error && <div className="col-span-full"><ErrorNotice message={context.error} /></div>}
      <section aria-labelledby="linear-link-heading" className="min-w-0">
        <h2 id="linear-link-heading" className="mb-1 text-[14px] font-semibold text-text-bright">Link an existing issue</h2>
        <p className="mb-3 text-[12px] text-dim">Search Linear, then confirm the issue you want attached to this session.</p>
        <form
          className="flex gap-2"
          onSubmit={(event) => { event.preventDefault(); send({ type: "SEARCH" }) }}
        >
          <label className="sr-only" htmlFor="linear-search">Search Linear issues</label>
          <input
            id="linear-search"
            value={context.query}
            onChange={(event) => send({ type: "SEARCH_CHANGED", query: event.currentTarget.value })}
            placeholder="Search by identifier or title"
            className="min-w-0 flex-1 rounded border border-line bg-panel px-3 py-2 text-[12px] text-text outline-none placeholder:text-dim focus:border-blue"
          />
          <button type="submit" className="inline-flex items-center gap-1.5 rounded border border-line px-3 py-2 text-[12px] text-text hover:border-blue">
            <Search size={13} /> Search
          </button>
        </form>
        <div className="mt-3 flex flex-col gap-2" aria-live="polite">
          {context.results.map((issue) => (
            <div key={issue.id} className="flex items-start gap-3 rounded border border-line bg-panel px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-medium text-purple">{issue.identifier}</div>
                <div className="truncate text-[12.5px] text-text-bright">{issue.title}</div>
              </div>
              <button
                type="button"
                aria-label={`Link ${issue.identifier}`}
                onClick={() => send({ type: "LINK", issue })}
                className="inline-flex flex-none items-center gap-1 rounded border border-line px-2 py-1 text-[11.5px] text-text hover:border-purple"
              >
                <Link2 size={12} /> Link issue
              </button>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="linear-create-heading" className={cn("min-w-0", atLeast(tier, "wide") ? "border-l border-line pl-6" : "border-t border-line pt-5")}>
        <h2 id="linear-create-heading" className="mb-1 text-[14px] font-semibold text-text-bright">Create an issue</h2>
        <p className="mb-3 text-[12px] text-dim">The new Linear issue will be linked to this session.</p>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => { event.preventDefault(); send({ type: "CREATE_SUBMIT" }) }}
        >
          <label className="flex flex-col gap-1 text-[11.5px] text-dim">
            Team
            <select
              value={context.createInput.teamId}
              onChange={(event) => send({ type: "CREATE_CHANGED", field: "teamId", value: event.currentTarget.value })}
              className="rounded border border-line bg-panel px-3 py-2 text-[12px] text-text outline-none focus:border-blue"
            >
              {context.workspace?.teams.map((team) => <option key={team.id} value={team.id}>{team.name} ({team.key})</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11.5px] text-dim">
            Title
            <input
              required
              value={context.createInput.title}
              onChange={(event) => send({ type: "CREATE_CHANGED", field: "title", value: event.currentTarget.value })}
              className="rounded border border-line bg-panel px-3 py-2 text-[12px] text-text outline-none focus:border-blue"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11.5px] text-dim">
            Description
            <textarea
              rows={5}
              value={context.createInput.description}
              onChange={(event) => send({ type: "CREATE_CHANGED", field: "description", value: event.currentTarget.value })}
              className="resize-y rounded border border-line bg-panel px-3 py-2 text-[12px] text-text outline-none focus:border-blue"
            />
          </label>
          <button type="submit" className="inline-flex w-fit items-center gap-1.5 rounded bg-purple px-3 py-2 text-[12px] font-medium text-editor hover:opacity-90">
            <Plus size={13} /> Create and link
          </button>
        </form>
      </section>
    </div>
  )
}

function Metadata({ issue }: { readonly issue: LinearIssueDetail }) {
  const rows = [
    ["Status", issue.statusName ?? (issue.state === "open" ? "Open" : "Closed")],
    ["Priority", issue.priority.label],
    ["Team", issue.team.name],
    ["Assignee", issue.assignees.map((actor) => actor.name).join(", ") || "Unassigned"],
    ["Project", issue.project?.name],
    ["Cycle", issue.cycle?.name]
  ].filter((row) => row[1])
  return (
    <aside aria-label="Issue metadata" className="rounded-md border border-line bg-panel px-3 py-3">
      <dl className="grid grid-cols-[80px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[11.5px]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-dim">{label}</dt><dd className="truncate text-text">{value}</dd>
          </div>
        ))}
      </dl>
      {issue.labels.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5 border-t border-line pt-3">{issue.labels.map((label) => <IssueLabelChip key={label.name} name={label.name} color={label.color ?? undefined} />)}</div>}
    </aside>
  )
}

function DetailView({
  issue,
  error,
  busy,
  commentBody,
  send,
  openExternal
}: {
  readonly issue: LinearIssueDetail
  readonly error: string | null
  readonly busy: boolean
  readonly commentBody: string
  readonly send: LinearIssueSend
  readonly openExternal: (url: string) => Promise<void>
}) {
  const tier = useWidthTier()
  return (
    <div className={cn("grid gap-5", atLeast(tier, "wide") ? "grid-cols-[minmax(0,1fr)_220px]" : "grid-cols-1")}>
      <main className="min-w-0">
        {error && <div className="mb-3"><ErrorNotice message={error} /></div>}
        <div className="mb-4 flex flex-wrap items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="mb-1 text-[12px] font-medium text-purple">{issue.identifier}</div>
            <h1 className="text-[21px] font-semibold leading-tight text-text-bright">{issue.title}</h1>
          </div>
          <button type="button" disabled={busy} onClick={() => send({ type: "REFRESH" })} className="inline-flex items-center gap-1 rounded border border-line px-2 py-1.5 text-[11.5px] text-text hover:border-blue disabled:opacity-50"><RefreshCw size={12} /> Refresh</button>
          <button type="button" onClick={async () => openExternal(issue.url)} className="inline-flex items-center gap-1 rounded border border-line px-2 py-1.5 text-[11.5px] text-text hover:border-purple"><ExternalLink size={12} /> Open in Linear</button>
          <button type="button" disabled={busy} onClick={() => send({ type: "UNLINK" })} className="inline-flex items-center gap-1 rounded border border-line px-2 py-1.5 text-[11.5px] text-text hover:border-red disabled:opacity-50"><Unlink size={12} /> {busy ? "Working…" : "Unlink"}</button>
        </div>
        <section aria-label="Description" className="mb-4 rounded-md border border-line bg-editor px-4 py-4">
          {issue.body.trim() ? <Markdown>{issue.body}</Markdown> : <p className="text-[12px] italic text-dim">No description provided.</p>}
        </section>
        <section aria-labelledby="linear-comments" className="flex flex-col gap-3">
          <h2 id="linear-comments" className="flex items-center gap-1.5 text-[13px] font-semibold text-text-bright"><MessageSquare size={14} /> Comments ({issue.comments.length})</h2>
          {issue.comments.map((comment) => <Comment key={comment.id} comment={comment} />)}
          <form className="rounded-md border border-line bg-panel p-3" onSubmit={(event) => { event.preventDefault(); send({ type: "COMMENT_SUBMIT" }) }}>
            <label htmlFor="linear-comment" className="mb-2 block text-[11.5px] font-medium text-text">Add a comment</label>
            <textarea id="linear-comment" rows={3} value={commentBody} onChange={(event) => send({ type: "COMMENT_CHANGED", body: event.currentTarget.value })} className="w-full resize-y rounded border border-line bg-editor px-3 py-2 text-[12px] text-text outline-none focus:border-blue" />
            <button type="submit" disabled={busy || !commentBody.trim()} className="mt-2 rounded bg-purple px-3 py-1.5 text-[12px] font-medium text-editor disabled:opacity-50">{busy ? "Posting…" : "Comment"}</button>
          </form>
        </section>
      </main>
      <Metadata issue={issue} />
    </div>
  )
}

const routeFor = (session: SessionSnapshot) => ({
  sessionId: session.id,
  repository: { name: session.repo, path: session.worktreePath ?? "" }
})

function LinearSetupFlyout({
  session,
  open,
  onClose,
  onConfigured
}: {
  readonly session: SessionSnapshot
  readonly open: boolean
  readonly onClose: () => void
  readonly onConfigured: () => void
}) {
  const host = useHost()
  const route = useMemo(() => routeFor(session), [session])
  const [configuration, setConfiguration] = useState<LinearConfiguration | null>(null)
  const [selection, setSelection] = useState<LinearSelection | null>(null)
  const [name, setName] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    const next = await host.invoke<LinearConfiguration>("linear.configuration", route)
    setConfiguration(next)
    setSelection(next.resolved)
    return next
  }

  useEffect(() => {
    if (!open) return
    setError(null)
    void load().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [open, route])

  if (!open) return null
  const profile = configuration?.profiles.find(({ id }) => id === selection?.profileId) ?? null
  const run = async (action: () => Promise<LinearConfiguration>) => {
    setBusy(true)
    setError(null)
    try {
      const next = await action()
      setConfiguration(next)
      setSelection(next.resolved)
      onConfigured()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const selected = (): LinearSelection => {
    if (!selection) throw new Error("Choose a Linear account.")
    return selection
  }

  return (
    <aside aria-label="Linear setup" className="absolute right-3 top-12 z-30 w-[min(420px,calc(100%-24px))] rounded-lg border border-line bg-editor p-4 shadow-xl">
      <div className="mb-3 flex items-center justify-between">
        <div><h2 className="text-[14px] font-semibold text-text-bright">Linear setup</h2><p className="text-[11.5px] text-dim">{session.repo}</p></div>
        <button type="button" aria-label="Close Linear setup" onClick={onClose} className="rounded p-1 text-dim hover:bg-panel hover:text-text"><X size={15} /></button>
      </div>
      {error && <div className="mb-3"><ErrorNotice message={error} /></div>}
      <label className="mb-3 flex flex-col gap-1 text-[11.5px] text-dim">
        Account
        <select
          value={selection?.profileId ?? ""}
          onChange={(event) => setSelection({ profileId: event.currentTarget.value })}
          className="rounded border border-line bg-panel px-3 py-2 text-[12px] text-text"
        >
          <option value="">Choose an account</option>
          {configuration?.profiles.map((item) => <option key={item.id} value={item.id}>{item.name} — {item.workspace.name}</option>)}
        </select>
      </label>
      {profile && (
        <div className="mb-3 grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-[11.5px] text-dim">Team
            <select value={selection?.teamId ?? ""} onChange={(event) => setSelection({ ...selected(), teamId: event.currentTarget.value || undefined })} className="rounded border border-line bg-panel px-2 py-2 text-[12px] text-text">
              <option value="">No default</option>{profile.teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11.5px] text-dim">Project
            <select value={selection?.projectId ?? ""} onChange={(event) => setSelection({ ...selected(), projectId: event.currentTarget.value || undefined })} className="rounded border border-line bg-panel px-2 py-2 text-[12px] text-text">
              <option value="">No default</option>{profile.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
        </div>
      )}
      <div className="mb-4 flex flex-wrap gap-2">
        <button type="button" disabled={busy || !selection} onClick={() => void run(() => host.invoke<LinearConfiguration>("linear.session-override", { ...route, selection: selected() }))} className="rounded bg-purple px-2.5 py-1.5 text-[11.5px] font-medium text-editor disabled:opacity-50">Use for this session</button>
        <button type="button" disabled={busy || !selection} onClick={() => void run(() => host.invoke<LinearConfiguration>("linear.repo-default", { ...route, selection: selected() }))} className="rounded border border-line px-2.5 py-1.5 text-[11.5px] text-text disabled:opacity-50">Save as repo default</button>
        {configuration?.sessionOverride && <button type="button" disabled={busy} onClick={() => void run(() => host.invoke<LinearConfiguration>("linear.session-reset", route))} className="rounded border border-line px-2.5 py-1.5 text-[11.5px] text-text">Reset override</button>}
        {profile && !profile.legacy && <button type="button" aria-label={`Remove ${profile.name}`} disabled={busy} onClick={() => void run(() => host.invoke<LinearConfiguration>("linear.profile-remove", { ...route, profileId: profile.id }))} className="rounded border border-red/50 p-1.5 text-red"><Trash2 size={13} /></button>}
      </div>
      <form className="border-t border-line pt-3" onSubmit={(event) => {
        event.preventDefault()
        void run(() => host.invoke<LinearConfiguration>("linear.profile-add", { ...route, name, apiKey })).then(() => { setName(""); setApiKey("") })
      }}>
        <h3 className="mb-2 text-[12px] font-medium text-text-bright">Add account</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          <input aria-label="Account name" required placeholder="Work Linear" value={name} onChange={(event) => setName(event.currentTarget.value)} className="rounded border border-line bg-panel px-2.5 py-2 text-[12px] text-text" />
          <input aria-label="Linear API key" required type="password" placeholder="lin_api_…" value={apiKey} onChange={(event) => setApiKey(event.currentTarget.value)} className="rounded border border-line bg-panel px-2.5 py-2 text-[12px] text-text" />
        </div>
        <div className="mt-2 flex items-center gap-2"><button type="submit" disabled={busy} className="rounded border border-purple px-2.5 py-1.5 text-[11.5px] text-text">Add account</button><button type="button" onClick={() => void host.openExternal("https://linear.app/settings/api")} className="text-[11.5px] text-purple hover:underline">Create API key</button></div>
      </form>
    </aside>
  )
}

function LinearIssueView({ session }: { readonly session: SessionSnapshot }) {
  const host = useHost()
  const { linkIssue, removeIssue } = useSessionActions()
  const [setupOpen, setSetupOpen] = useState(false)
  const services = useMemo(
    () => linearServices(host, session, linkIssue, removeIssue),
    [host, linkIssue, removeIssue, session]
  )
  const [snapshot, send] = useMachine(linearIssueMachine, {
    input: { linkedIssue: session.linkedIssue, services }
  })
  const { context } = snapshot
  const waiting = snapshot.matches("checkingConfiguration") || snapshot.matches("loadingContext") || snapshot.matches("loadingIssue") || snapshot.matches("searching") || snapshot.matches("creating") || snapshot.matches("linking") || snapshot.matches("unlinking")

  return (
    <div data-testid="linear-issue-body" className="relative flex min-h-0 flex-1 flex-col overflow-auto bg-editor">
      <div className="border-b border-line bg-panel px-4 py-2.5">
        <div className="mx-auto flex max-w-[980px] items-center gap-2 text-[12px] font-medium text-text-bright"><LinearMark className="h-4 w-4" /> Linear <span className="font-normal text-dim">{context.workspace?.workspace.name}</span><button type="button" aria-label="Configure Linear for this session" onClick={() => setSetupOpen((value) => !value)} className="ml-auto rounded p-1 text-dim hover:bg-editor hover:text-text"><SlidersHorizontal size={14} /></button></div>
      </div>
      <LinearSetupFlyout session={session} open={setupOpen} onClose={() => setSetupOpen(false)} onConfigured={() => send({ type: "CONFIGURATION_CHANGED" })} />
      <div className="mx-auto w-full max-w-[980px] flex-1 px-4 py-6 md:px-7">
        {waiting && !context.issue && <div className="flex min-h-[220px] items-center justify-center text-dim"><Spinner size={20} /></div>}
        {snapshot.matches("needsConfiguration") && (
          <div className="mx-auto flex min-h-[280px] max-w-[460px] flex-col items-center justify-center gap-3 text-center">
            <LinearMark className="h-8 w-8" />
            <h1 className="text-[16px] font-semibold text-text-bright">Connect Linear</h1>
            <p className="text-[12.5px] leading-relaxed text-dim">Connect a named Linear account, then choose workspace defaults for this repository or only this session. Jingler encrypts API keys and never exposes them to the agent.</p>
            <button type="button" onClick={() => setSetupOpen(true)} className="inline-flex items-center gap-1.5 rounded bg-purple px-3 py-2 text-[12px] font-medium text-editor"><Settings size={13} /> Set up Linear</button>
          </div>
        )}
        {snapshot.matches("unlinked") && <UnlinkedView snapshot={snapshot} send={send} />}
        {snapshot.matches("error") && <div className="mx-auto flex min-h-[260px] max-w-[460px] flex-col items-center justify-center gap-3"><ErrorNotice message={context.error ?? "Linear request failed."} /><div className="flex gap-2"><button type="button" onClick={() => send({ type: "RETRY" })} className="rounded border border-line px-3 py-2 text-[12px] text-text hover:border-blue">Retry</button>{context.linkedIssue?.providerId === "linear" && <button type="button" onClick={() => send({ type: "UNLINK" })} className="inline-flex items-center gap-1 rounded border border-line px-3 py-2 text-[12px] text-text hover:border-red"><Unlink size={12} /> Unlink issue</button>}</div></div>}
        {context.issue && (snapshot.matches("detail") || snapshot.matches("commenting") || snapshot.matches("unlinking") || snapshot.matches("loadingIssue")) && <DetailView issue={context.issue} error={context.error} busy={snapshot.matches("commenting") || snapshot.matches("unlinking") || snapshot.matches("loadingIssue")} commentBody={context.commentBody} send={send} openExternal={host.openExternal} />}
      </div>
    </div>
  )
}

export function IssueTab({ session }: TabProps) {
  const selected = session.linkedIssue
  const selectedKey = selected
    ? `${selected.providerId}:${selected.providerAccountId ?? ""}:${selected.id}`
    : "unlinked"
  return <LinearIssueView key={`${session.id}:${selectedKey}`} session={session} />
}

export default definePlugin(manifest, { views: { "linear.issue": IssueTab } })
