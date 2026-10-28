import { useEffect, useRef, useState } from "react"
import type { ReactNode } from "react"
import type { Project, Session, SessionActivity } from "@jingler/core"
import { CircleDot, FolderGit2, GitFork, GitPullRequest } from "lucide-react"
import { HomeCards } from "../composites/home-cards.js"
import { CHECKOUT_OPTIONS, ChipRow, FromChip } from "../composites/new-workspace-chips.js"
import { Button } from "../components/button.js"
import { Kbd } from "../components/kbd.js"
import { ChipMenu } from "../components/chip-menu.js"
import { Composer } from "../composites/composer.js"

export const greetingFor = (now: Date, firstName?: string) => {
  const hour = now.getHours()
  const part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"
  return firstName ? `Good ${part}, ${firstName}` : `Good ${part}`
}

const initialProjectId = (projects: ReadonlyArray<Project>, selectedProjectId?: string | null) =>
  projects.find((project) => project.id === selectedProjectId)?.id ?? projects[0]?.id ?? ""

const STARTERS = [
  { label: "Start from a GitHub issue", source: "github" },
  { label: "Start from a PR", source: "pr" }
] as const

const FROM_SOURCES = [
  { value: "pr" as const, label: "Pull request", icon: <GitPullRequest size={15} aria-hidden /> },
  { value: "github" as const, label: "GitHub issue", icon: <CircleDot size={15} aria-hidden /> }
]

/** What Home hands to New workspace as its prefill. */
export interface HomeStart {
  draft: string
  projectId: string | undefined
  source?: "pr" | "github"
  baseBranch?: string
  isolation?: "worktree" | "direct"
}

type HomeSource = "blank" | "branch" | "pr" | "github"
const fromLabel = (source: HomeSource, branch: string) =>
  source === "pr" ? "from Pull request" : source === "github" ? "from GitHub issue" : `from ${branch || "main"}`

/**
 * Home (spec §5c): greeting, the "What should we build?" composer with a project chip,
 * the starter rows on first run, then Needs you / Running cards and the import card.
 * Submitting hands the prompt + project to New workspace, which owns session creation.
 */
export function EmptyConversation({
  version,
  onNewSession,
  onStartWithPrompt,
  loadBranches,
  projects = [],
  selectedProjectId,
  userName,
  now = new Date(),
  sessions,
  liveActivity,
  onOpenSession,
  allowFor,
  importCard
}: {
  sessions?: ReadonlyArray<Session>
  liveActivity?: Record<string, SessionActivity>
  onOpenSession?: (sessionId: string) => void
  allowFor?: (sessionId: string) => (() => void) | undefined
  /** Home › the MCP import card, owned by the host (null = none). */
  importCard?: ReactNode
  version?: string
  onNewSession?: () => void
  /** Opens New workspace prefilled with the prompt and chosen project. */
  onStartWithPrompt?: (start: HomeStart) => void
  /** Branch list for the from-chip. */
  loadBranches?: (repoPath: string) => Promise<ReadonlyArray<string>>
  projects?: ReadonlyArray<Project>
  selectedProjectId?: string | null
  /** Signed-in user's display name; only the first word is shown. */
  userName?: string
  now?: Date
}) {
  const [draft, setDraft] = useState("")
  const [projectId, setProjectId] = useState(initialProjectId(projects, selectedProjectId))
  const [source, setSource] = useState<HomeSource>("blank")
  const [branches, setBranches] = useState<ReadonlyArray<string>>([])
  const [baseBranch, setBaseBranch] = useState("")
  const [isolation, setIsolation] = useState<"worktree" | "direct">("worktree")
  const selectedProject = projects.find((project) => project.id === projectId)
  const projectPath = selectedProject?.path
  useEffect(() => {
    if (!projectPath || !loadBranches) return
    let live = true
    setBaseBranch("")
    loadBranches(projectPath).then(
      (list) => {
        if (!live) return
        setBranches(list)
        setBaseBranch(list.find((b) => b === "main") ?? list.find((b) => b === "master") ?? list[0] ?? "")
      },
      () => live && setBranches([])
    )
    return () => { live = false }
  }, [projectPath, loadBranches])
  const composerRef = useRef<HTMLDivElement>(null)
  const firstRun = !sessions?.some((session) => !session.archived)
  const start = (text: string, from: HomeSource) =>
    onStartWithPrompt?.({
      draft: text,
      projectId: projectId || undefined,
      ...(from === "pr" || from === "github" ? { source: from } : {}),
      ...(baseBranch ? { baseBranch } : {}),
      isolation
    })
  return (
    <div className="flex flex-1 flex-col bg-editor">
      <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 sm:px-10">
        <div className="flex w-full max-w-[760px] flex-col gap-5">
          <h1 className="m-0 text-[20px] font-semibold tracking-[-0.2px] text-text-bright">
            {greetingFor(now, userName?.trim().split(/\s+/)[0])}
          </h1>

          <div ref={composerRef} className="flex flex-col gap-2">
            <Composer
              preserveDraftOnSend
              autoFocus
              focusKey="home"
              value={draft}
              onValueChange={setDraft}
              onSend={(text) => text.trim() && start(text.trim(), source)}
              placeholder="What should we build?"
              inputLabel="What should we build?"
              repo={selectedProject?.name}
              branch={baseBranch || undefined}
            />
            <div className="flex items-center gap-2">
              <ChipRow>
                {projects.length > 0 && (
                  <ChipMenu
                    value={projectId}
                    options={projects.map((project) => ({ value: project.id, label: project.name, searchText: project.name }))}
                    onSelect={setProjectId}
                    ariaLabel="Project"
                    icon={<FolderGit2 size={12} aria-hidden />}
                  />
                )}
                {projects.length > 0 && (
                  <FromChip
                    label={fromLabel(source, baseBranch)}
                    source={source}
                    branches={branches}
                    baseBranch={baseBranch}
                    sourceOptions={FROM_SOURCES}
                    onSource={(next) => setSource(next === "pr" || next === "github" ? next : "blank")}
                    onBranch={setBaseBranch}
                  />
                )}
                {projects.length > 0 && (
                  <ChipMenu
                    value={isolation}
                    options={CHECKOUT_OPTIONS}
                    onSelect={setIsolation}
                    ariaLabel="Checkout"
                    icon={<GitFork size={12} aria-hidden />}
                  />
                )}
              </ChipRow>
            </div>
          </div>

          {firstRun && (
            <div className="flex flex-col" data-testid="home-starters">
              {STARTERS.map(({ label, source: from }) => (
                <Button
                  key={label}
                  variant="ghost"
                  onClick={() => (projectId && onStartWithPrompt ? start(draft.trim(), from) : onNewSession?.())}
                  className="w-full justify-start"
                >
                  {label}
                </Button>
              ))}
              <Button variant="ghost" onClick={() => composerRef.current?.querySelector("textarea")?.focus()} className="w-full justify-start">
                Describe a task
              </Button>
            </div>
          )}

          {sessions && liveActivity && onOpenSession ? (
            <HomeCards sessions={sessions} liveActivity={liveActivity} onOpenSession={onOpenSession} allowFor={allowFor} />
          ) : null}
          {importCard ? <div className="w-full text-left">{importCard}</div> : null}
        </div>
      </div>

      {/* Keyboard hint bar */}
      <div className="flex h-[38px] flex-none items-center gap-5 border-t border-hairline bg-panel px-[18px] text-[11px] text-dim">
        <Shortcut keys="⌘N" label="New session" />
        <Shortcut keys="⌘K" label="Command palette" />
        <Shortcut keys="⌘," label="Settings" />
        <div className="flex-1" />
        <span className="font-mono">{version ? `Jingler v${version}` : "Jingler"}</span>
      </div>
    </div>
  )
}

function Shortcut({ keys, label }: { keys: string; label: string }) {
  return (
    <span className="flex items-center gap-[7px]">
      <Kbd>{keys}</Kbd>
      {label}
    </span>
  )
}
