import { useState, type ReactNode } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  adversarialReview,
  localChanges,
  omittedFiles,
  prChanges,
  prThreads,
  sampleDrafts
} from "../screens/changes-review.fixtures.js"
import {
  ChangedFilesExplorer,
  ExplorerPanel,
  ReviewFileDiff,
  ReviewSidebar,
  type ExplorerFilter
} from "./changes-review.js"
import type { ReviewDraft } from "./review-tray.js"

/**
 * The changes review pieces one at a time, for styling. The same components
 * compose into `Flows/Changes review`.
 */
const meta: Meta = {
  title: "Changes review/Components",
  parameters: { layout: "fullscreen" }
}
export default meta
type Story = StoryObj

function Frame({ width, children }: { readonly width: number; readonly children: ReactNode }) {
  return (
    <div className="flex h-screen bg-canvas p-4">
      <div
        className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-panel"
        style={{ width }}
      >
        {children}
      </div>
    </div>
  )
}

const files = (set: typeof localChanges) => set.map(({ file }) => file)
const diffs = (set: typeof localChanges) => set.map(({ diff }) => diff)

function Explorer({
  initial,
  prAvailable = true
}: {
  readonly initial: ExplorerFilter
  readonly prAvailable?: boolean
}) {
  const [filter, setFilter] = useState<ExplorerFilter>(initial)
  const [active, setActive] = useState<string | null>(null)
  const set = filter === "pr" ? prChanges : localChanges
  return (
    <Frame width={280}>
      <ExplorerPanel
        branch="feat/session-refresh"
        worktreePath="/Users/morgan/repos/auth-service/.worktrees/session-refresh"
        filter={filter}
        onFilterChange={setFilter}
        localAvailable
        prAvailable={prAvailable}
      >
        {filter === "all" ? (
          <div className="p-4 text-[12px] text-dim">The repository tree renders here.</div>
        ) : (
          <ChangedFilesExplorer
            files={files(set)}
            fileDiffs={diffs(set)}
            drafts={filter === "pr" ? sampleDrafts : []}
            reviewThreads={filter === "pr" ? prThreads : []}
            review={filter === "pr" ? adversarialReview : null}
            activePath={active}
            onSelectFile={setActive}
          />
        )}
      </ExplorerPanel>
    </Frame>
  )
}

/** The filter on the unfiltered repository. */
export const ExplorerAllFiles: Story = { render: () => <Explorer initial="all" /> }

/** Uncommitted changes: status, counts, search and kind filters. */
export const ExplorerUncommitted: Story = { render: () => <Explorer initial="local" /> }

/** PR changes, with feedback counts from drafts, threads and findings. */
export const ExplorerPullRequest: Story = { render: () => <Explorer initial="pr" /> }

/** No linked PR: the Pull request option is disabled. */
export const ExplorerWithoutPullRequest: Story = {
  render: () => <Explorer initial="local" prAvailable={false} />
}

/** Oversized files are named with their counts rather than silently missing. */
export const ExplorerOmittedFiles: Story = {
  render: () => (
    <Frame width={280}>
      <ChangedFilesExplorer
        files={files(localChanges)}
        fileDiffs={diffs(localChanges)}
        omittedFiles={omittedFiles}
        diffLineLimit={5000}
        drafts={[]}
        activePath={null}
        onSelectFile={() => {}}
      />
    </Frame>
  )
}

/** Nothing to review. */
export const ExplorerEmpty: Story = {
  render: () => (
    <Frame width={280}>
      <ChangedFilesExplorer files={[]} fileDiffs={[]} drafts={[]} activePath={null} onSelectFile={() => {}} />
    </Frame>
  )
}

function Diff({
  index,
  source,
  initialDrafts = [],
  withFindings = false,
  viewed = false
}: {
  readonly index: number
  readonly source: "local" | "pr"
  readonly initialDrafts?: readonly ReviewDraft[]
  readonly withFindings?: boolean
  readonly viewed?: boolean
}) {
  const set = source === "pr" ? prChanges : localChanges
  const entry = set[index]!
  const [drafts, setDrafts] = useState(initialDrafts)
  const [isViewed, setViewed] = useState(viewed)
  const [focused, setFocused] = useState(false)
  return (
    <Frame width={900}>
      <ReviewFileDiff
        file={{ ...entry.file, viewed: isViewed }}
        diff={entry.diff.diff}
        source={source}
        drafts={drafts}
        reviewThreads={source === "pr" ? prThreads : []}
        review={withFindings ? adversarialReview : null}
        connected
        routeTargetSession="Refresh expired sessions"
        focused={focused}
        onToggleFocus={() => setFocused((value) => !value)}
        toolbar={<span className="font-mono text-[10.5px] text-text">{entry.file.path}</span>}
        onAddDraft={(draft) => setDrafts((current) => [...current, { id: `d${current.length}`, ...draft }])}
        onRemoveDraft={(id) => setDrafts((current) => current.filter((draft) => draft.id !== id))}
        onToggleViewed={(_path, next) => setViewed(next)}
        onRevertLines={() => {}}
        onRevertFile={() => {}}
        onDeslopFile={() => {}}
        onSendFindingToAgent={() => {}}
      />
    </Frame>
  )
}

/** An uncommitted diff: revert and deslop in the header, select a line to comment. */
export const DiffUncommitted: Story = { render: () => <Diff index={0} source="local" /> }

/** A PR diff with a reviewer's thread and a saved draft inline. */
export const DiffPullRequestThreadAndDraft: Story = {
  render: () => <Diff index={0} source="pr" initialDrafts={sampleDrafts.slice(0, 1)} />
}

/** A new file carrying an adversarial finding. */
export const DiffPullRequestFinding: Story = {
  render: () => <Diff index={1} source="pr" withFindings />
}

/** Marked viewed. */
export const DiffViewed: Story = { render: () => <Diff index={2} source="local" viewed /> }

function Tray({
  drafts,
  source = "pr",
  connected = true,
  findings = false
}: {
  readonly drafts: readonly ReviewDraft[]
  readonly source?: "local" | "pr"
  readonly connected?: boolean
  readonly findings?: boolean
}) {
  const [current, setCurrent] = useState(drafts)
  return (
    <div className="flex h-screen justify-end bg-canvas">
      <ReviewSidebar
        drafts={current}
        source={source}
        connected={connected}
        review={findings ? adversarialReview : null}
        routeTargetSession="Refresh expired sessions"
        paths={new Set(prChanges.map(({ file }) => file.path))}
        onConnectGithub={() => {}}
        onRemoveDraft={(id) => setCurrent((list) => list.filter((draft) => draft.id !== id))}
        onFinishReview={() => setCurrent([])}
      />
    </div>
  )
}

/** Collected drafts, ready to send or post. */
export const TrayDrafts: Story = { render: () => <Tray drafts={sampleDrafts} /> }

/** A finding no file owns keeps the tray open even with no drafts. */
export const TrayGeneralFinding: Story = { render: () => <Tray drafts={[]} findings /> }

/** Drafts plus general findings. */
export const TrayDraftsAndFindings: Story = { render: () => <Tray drafts={sampleDrafts} findings /> }

/** GitHub not connected: posting needs a connection first. */
export const TrayDisconnected: Story = {
  render: () => <Tray drafts={sampleDrafts} connected={false} />
}

/** Uncommitted source: drafts go to the agent; there is no PR to post to. */
export const TrayUncommitted: Story = { render: () => <Tray drafts={sampleDrafts} source="local" /> }

/** Nothing collected: the tray renders nothing at all. */
export const TrayEmpty: Story = { render: () => <Tray drafts={[]} /> }
