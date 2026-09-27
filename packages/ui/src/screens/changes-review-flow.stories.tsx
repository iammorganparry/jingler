import { useMemo, useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import type { Project, Session } from "@jingler/core"
import { FileCode2, MessageSquare } from "lucide-react"
import { AppShell } from "../app/app-shell.js"
import { TitleSearch } from "../app/title-search.js"
import { AssetRepositoryTree } from "../asset/asset-browser.js"
import { Button } from "../components/button.js"
import {
  ChangedFilesExplorer,
  ExplorerPanel,
  ReviewFileDiff,
  ReviewSidebar,
  type ExplorerFilter,
  type ReviewDraftInput,
  type ReviewSource
} from "../composites/changes-review.js"
import type { ReviewDraft } from "../composites/review-tray.js"
import { testSession } from "../test-support.js"
import {
  adversarialReview,
  localChanges,
  omittedFiles,
  prChanges,
  prThreads,
  repositoryEntries,
  sampleDrafts,
  sourceFor as sourceText
} from "./changes-review.fixtures.js"
import { SessionConversation } from "./session-conversation.js"

/**
 * Changes review, end to end, on the real app chrome: the sidebar Explorer
 * with its All / Uncommitted / Pull request filter, the Changes rail button,
 * the Files view's review diff, Focus, and the review tray that exists only
 * once something has been collected.
 *
 * Everything is live: add a comment on a diff line and the tray appears; send
 * it and the tray goes; revert a file and it leaves the change set; Focus
 * collapses the sidebar and tray. Each story below is a starting state.
 */
const meta: Meta = {
  title: "Flows/Changes review",
  parameters: { layout: "fullscreen" }
}
export default meta
type Story = StoryObj

const project: Project = {
  id: "auth",
  name: "auth-service",
  path: "/Users/morgan/repos/auth-service",
  availability: "available",
  createdAt: "2026-09-01T09:00:00Z",
  updatedAt: "2026-09-20T09:00:00Z"
}

const localSession: Session = testSession({
  id: "changes-local",
  projectId: project.id,
  repo: project.name,
  repoPath: project.path,
  title: "Shorten session TTL",
  branch: "feat/short-session-ttl",
  worktreePath: `${project.path}/.worktrees/short-session-ttl`,
  prNumber: null,
  diff: { added: 7, removed: 2 },
  updatedAt: "2026-09-20T12:00:00Z"
})

const prSession: Session = {
  ...localSession,
  id: "changes-pr",
  title: "Refresh expired sessions",
  branch: "feat/session-refresh",
  prNumber: 482
}

interface FlowSetup {
  /** The session has a linked pull request. */
  readonly pr?: boolean
  /** GitHub is reachable. Offline, the PR filter falls back to uncommitted. */
  readonly connected?: boolean
  readonly filter?: ExplorerFilter
  readonly openPath?: string | null
  readonly drafts?: readonly ReviewDraft[]
  readonly focused?: boolean
  /** Attach the adversarial review's findings to the PR diff. */
  readonly findings?: boolean
  /** List files whose patch was too large to transport. */
  readonly omitted?: boolean
  /** Nothing has changed yet. */
  readonly empty?: boolean
  /** Constrain the window width, to check the layout when it's tight. */
  readonly width?: number
}

const toggled = (set: ReadonlySet<string>, value: string, on: boolean): ReadonlySet<string> => {
  const next = new Set(set)
  if (on) next.add(value)
  else next.delete(value)
  return next
}

/** A story's starting state, with every default applied. */
const initialFlow = (setup: FlowSetup) => ({
  session: setup.pr ? prSession : localSession,
  connected: setup.connected ?? true,
  filter: setup.filter ?? ("all" as ExplorerFilter),
  openPath: setup.openPath ?? null,
  drafts: setup.drafts ?? [],
  focused: setup.focused ?? false,
  tabRequest: setup.openPath ? { tabId: "files" as const, nonce: 1 } : null
})

/**
 * A PR that can't be fetched (GitHub offline) falls back to the uncommitted
 * work, and the filter shows the source actually listed.
 */
const sourceFor = (filter: ExplorerFilter, session: Session, connected: boolean): ReviewSource =>
  filter === "pr" && session.prNumber !== null && connected ? "pr" : "local"

const changeSet = (setup: FlowSetup, source: ReviewSource, reverted: ReadonlySet<string>) => {
  if (setup.empty) return []
  if (source === "pr") return prChanges
  return localChanges.filter((entry) => !reverted.has(entry.file.path))
}

/** The flow's state — what the app keeps in its review store and file browser. */
function useFlowState(setup: FlowSetup) {
  const [initial] = useState(() => initialFlow(setup))
  const { session, connected } = initial
  const [filter, setFilter] = useState<ExplorerFilter>(initial.filter)
  const [openPath, setOpenPath] = useState<string | null>(initial.openPath)
  const [drafts, setDrafts] = useState<readonly ReviewDraft[]>(initial.drafts)
  const [viewed, setViewed] = useState<ReadonlySet<string>>(new Set())
  const [reverted, setReverted] = useState<ReadonlySet<string>>(new Set())
  const [sentFindingIds, setSentFindingIds] = useState<ReadonlySet<string>>(new Set())
  const [focused, setFocused] = useState(initial.focused)
  const [mode, setMode] = useState<"diff" | "edit">("diff")
  const [tabRequest, setTabRequest] = useState<{ tabId: "files"; nonce: number } | null>(
    initial.tabRequest
  )
  const [log, setLog] = useState<string | null>(null)

  const source = sourceFor(filter, session, connected)
  const changes = useMemo(() => changeSet(setup, source, reverted), [reverted, setup, source])
  const files = useMemo(
    () => changes.map(({ file }) => (viewed.has(file.path) ? { ...file, viewed: true } : file)),
    [changes, viewed]
  )
  const fileDiffs = useMemo(() => changes.map(({ diff }) => diff), [changes])

  return {
    session,
    connected,
    filter,
    setFilter,
    shownFilter: filter === "all" ? ("all" as const) : source,
    source,
    openPath,
    mode,
    setMode,
    drafts,
    focused,
    setFocused,
    tabRequest,
    clearTabRequest: () => setTabRequest(null),
    log,
    setLog,
    files,
    fileDiffs,
    paths: new Set(files.map((file) => file.path)),
    threads: source === "pr" ? prThreads : [],
    review: source === "pr" && setup.findings ? adversarialReview : null,
    sentFindingIds,
    omitted: setup.omitted && source === "local" ? omittedFiles : [],
    openInFiles: (path: string, asDiff: boolean) => {
      setOpenPath(path)
      setMode(asDiff ? "diff" : "edit")
      setTabRequest((current) => ({ tabId: "files", nonce: (current?.nonce ?? 0) + 1 }))
    },
    addDraft: (draft: ReviewDraftInput) =>
      setDrafts((current) => [...current, { id: `draft-${current.length + 1}-${Date.now()}`, ...draft }]),
    removeDraft: (id: string) => setDrafts((current) => current.filter((draft) => draft.id !== id)),
    clearDrafts: () => setDrafts([]),
    toggleViewed: (path: string, on: boolean) => setViewed((current) => toggled(current, path, on)),
    revertFile: (path: string) => {
      setReverted((current) => toggled(current, path, true))
      setOpenPath(null)
      setLog(`Reverted ${path}`)
    },
    sendFinding: (id: string) => setSentFindingIds((current) => toggled(current, id, true))
  }
}

type FlowState = ReturnType<typeof useFlowState>

function FlowExplorer({ flow }: { readonly flow: FlowState }) {
  return (
    <ExplorerPanel
      branch={flow.session.branch}
      worktreePath={flow.session.worktreePath}
      filter={flow.shownFilter}
      onFilterChange={flow.setFilter}
      localAvailable
      prAvailable={flow.session.prNumber !== null}
    >
      {flow.filter === "all" ? (
        <AssetRepositoryTree
          entries={repositoryEntries}
          selectedPath={flow.openPath}
          onSelectPath={(path) => flow.openInFiles(path, false)}
        />
      ) : (
        <ChangedFilesExplorer
          files={flow.files}
          fileDiffs={flow.fileDiffs}
          omittedFiles={flow.omitted}
          diffLineLimit={flow.omitted.length > 0 ? 5000 : 0}
          drafts={flow.drafts}
          reviewThreads={flow.threads}
          review={flow.review}
          activePath={flow.openPath}
          onSelectFile={(path) => flow.openInFiles(path, true)}
        />
      )}
    </ExplorerPanel>
  )
}

function FlowFiles({ flow, path }: { readonly flow: FlowState; readonly path: string | null }) {
  if (path === null) {
    return (
      <div className="grid h-full place-items-center bg-canvas text-[12px] text-dim">
        Select a repository file to preview it.
      </div>
    )
  }
  const reviewing = flow.filter !== "all" && flow.paths.has(path)
  const file = reviewing && flow.mode === "diff" ? flow.files.find((f) => f.path === path) : undefined
  const toolbar = (
    <div className="flex items-center gap-1">
      <span className="font-mono text-[10.5px] text-text">{path}</span>
      {reviewing ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-[11px]"
          onClick={() => flow.setMode(flow.mode === "diff" ? "edit" : "diff")}
        >
          {flow.mode === "diff" ? "Edit" : "Diff"}
        </Button>
      ) : null}
    </div>
  )
  if (file === undefined) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-canvas">
        <div className="flex h-8 flex-none items-center border-b border-hairline bg-panel px-2">{toolbar}</div>
        <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-[12px] text-text-body">
          {sourceText(path)}
        </pre>
      </div>
    )
  }
  return (
    <ReviewFileDiff
      file={file}
      diff={flow.fileDiffs.find((entry) => entry.path === path)?.diff ?? ""}
      source={flow.source}
      drafts={flow.drafts}
      reviewThreads={flow.threads}
      review={flow.review}
      sentFindingIds={flow.sentFindingIds}
      connected={flow.connected}
      routeTargetSession={flow.session.title}
      focused={flow.focused}
      onToggleFocus={() => flow.setFocused(!flow.focused)}
      toolbar={toolbar}
      onAddDraft={flow.addDraft}
      onSendComment={(comment) => flow.setLog(`Sent to the agent: ${comment.path} L${comment.line} — ${comment.body}`)}
      onRemoveDraft={flow.removeDraft}
      onToggleViewed={flow.toggleViewed}
      onRevertLines={(range) => flow.setLog(`Reverted ${range.path} L${range.startLine}–${range.endLine}`)}
      onRevertFile={flow.revertFile}
      onDeslopFile={(target) => flow.setLog(`Asked the agent to deslop ${target}`)}
      onSendFindingToAgent={flow.sendFinding}
    />
  )
}

function FlowTray({ flow }: { readonly flow: FlowState }) {
  if (flow.focused) return null
  return (
    <ReviewSidebar
      drafts={flow.drafts}
      source={flow.source}
      connected={flow.connected}
      review={flow.filter === "all" ? null : flow.review}
      sentFindingIds={flow.sentFindingIds}
      routeTargetSession={flow.session.title}
      paths={flow.paths}
      onConnectGithub={() => flow.setLog("Opened GitHub settings")}
      onRemoveDraft={flow.removeDraft}
      onFinishReview={(finish) => {
        flow.setLog(
          finish === "send_to_agent"
            ? `Sent ${flow.drafts.length} comment(s) to the agent`
            : `Posted ${flow.drafts.length} comment(s) to GitHub`
        )
        flow.clearDrafts()
      }}
      onSendFindingToAgent={flow.sendFinding}
    />
  )
}

function FlowConversation({ flow }: { readonly flow: FlowState }) {
  const target = flow.session.prNumber !== null ? "pull request" : "uncommitted"
  return (
    <div className="flex h-full flex-col gap-3 bg-canvas p-8 text-[12.5px] text-muted-foreground">
      <div className="flex items-center gap-2 text-dim">
        <MessageSquare size={14} /> {flow.session.title}
      </div>
      <p className="max-w-xl">
        Click <strong className="text-text">Changes</strong> on the right rail to filter the Explorer
        to this session's {target} changes, then open a file to review its diff. Select a line to
        comment; the review tray appears once a comment is added.
      </p>
      {flow.log ? (
        <div className="flex w-fit items-center gap-2 rounded-md border border-line bg-panel px-3 py-1.5 font-mono text-[11px] text-text">
          <FileCode2 size={12} className="text-blue" /> {flow.log}
        </div>
      ) : null}
    </div>
  )
}

function ChangesReviewFlow(setup: FlowSetup) {
  const flow = useFlowState(setup)
  return (
    <div className="h-screen" style={setup.width ? { width: setup.width } : undefined}>
      <AppShell title="Changes review flow">
        <SessionConversation
          projects={[project]}
          sessions={[flow.session]}
          activeSessionId={flow.session.id}
          onSelectSession={() => {}}
          initialWorkspaceView={setup.filter && setup.filter !== "all" ? "explorer" : "sessions"}
          search={<TitleSearch onOpen={() => {}} className="w-full" />}
          sidebarCollapsed={flow.focused}
          onRevealChanges={() => {
            flow.setFocused(false)
            flow.setFilter(flow.session.prNumber !== null ? "pr" : "local")
          }}
          selectTabRequest={flow.tabRequest}
          onTabRequestHandled={flow.clearTabRequest}
          onOpenExplorerFile={(_id, path) => flow.openInFiles(path, flow.filter !== "all")}
          renderExplorer={() => <FlowExplorer flow={flow} />}
          renderFiles={(_session, ctx) => <FlowFiles flow={flow} path={ctx.path ?? flow.openPath} />}
          renderReviewTray={() => <FlowTray flow={flow} />}
          renderConversation={() => <FlowConversation flow={flow} />}
        />
      </AppShell>
    </div>
  )
}

/** Start here: a worktree with uncommitted edits. Press Changes on the rail. */
export const Uncommitted: Story = { render: () => <ChangesReviewFlow /> }

/** Already filtered, a file open on its diff, nothing collected yet — no tray. */
export const UncommittedFileOpen: Story = {
  render: () => <ChangesReviewFlow filter="local" openPath="src/auth/session.ts" />
}

/** A linked PR: its full diff, a reviewer's thread, and adversarial findings. */
export const PullRequest: Story = {
  render: () => (
    <ChangesReviewFlow pr findings filter="pr" openPath="src/auth/session.ts" />
  )
}

/** A finding pinned to a file opens beside its lines. */
export const PullRequestFindingOnFile: Story = {
  render: () => <ChangesReviewFlow pr findings filter="pr" openPath="src/auth/refresh.ts" />
}

/** Drafts collected: the tray is open with Comment only / Send to agent. */
export const WithDrafts: Story = {
  render: () => (
    <ChangesReviewFlow pr findings filter="pr" openPath="src/auth/session.ts" drafts={sampleDrafts} />
  )
}

/** GitHub offline: the PR can't be fetched, so the Explorer shows uncommitted work. */
export const PullRequestOffline: Story = {
  render: () => (
    <ChangesReviewFlow pr connected={false} filter="pr" openPath="src/auth/session.ts" />
  )
}

/** Focus: the sidebar and tray step aside; Exit focus brings them back. */
export const Focus: Story = {
  render: () => (
    <ChangesReviewFlow pr findings filter="pr" openPath="src/auth/session.ts" drafts={sampleDrafts} focused />
  )
}

/** Files too large to transport are listed with their counts above the tree. */
export const LargeFilesOmitted: Story = {
  render: () => <ChangesReviewFlow filter="local" omitted openPath="src/auth/session.ts" />
}

/** Nothing changed yet. */
export const NoChanges: Story = { render: () => <ChangesReviewFlow filter="local" empty /> }

/** The unfiltered Explorer: the whole repository, files open in the editor. */
export const AllFiles: Story = {
  render: () => <ChangesReviewFlow pr filter="all" openPath="README.md" />
}

/** A tight window: the tray still fits beside the diff. */
export const NarrowWindow: Story = {
  render: () => (
    <ChangesReviewFlow pr findings filter="pr" openPath="src/auth/session.ts" drafts={sampleDrafts} width={1024} />
  )
}
