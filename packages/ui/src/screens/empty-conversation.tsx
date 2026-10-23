import { useRef, useState } from "react"
import type { ReactNode } from "react"
import type { Project, Session, SessionActivity } from "@jingler/core"
import { FolderGit2 } from "lucide-react"
import { HomeCards } from "../composites/home-cards.js"
import { ChipRow } from "../composites/new-workspace-chips.js"
import { Button } from "../components/button.js"
import { ChipMenu } from "../components/chip-menu.js"
import { Textarea } from "../components/textarea.js"

export const greetingFor = (now: Date, firstName?: string) => {
  const hour = now.getHours()
  const part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"
  return firstName ? `Good ${part}, ${firstName}` : `Good ${part}`
}

const STARTERS = ["Start from a GitHub issue", "Start from a PR"] as const

/**
 * Home (spec §5c): greeting, the "What should we build?" composer with a project chip,
 * the starter rows on first run, then Needs you / Running cards and the import card.
 * Submitting hands the prompt + project to New workspace, which owns session creation.
 */
export function EmptyConversation({
  version,
  onNewSession,
  onStartWithPrompt,
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
  onStartWithPrompt?: (draft: string, projectId: string | undefined) => void
  projects?: ReadonlyArray<Project>
  selectedProjectId?: string | null
  /** Signed-in user's display name; only the first word is shown. */
  userName?: string
  now?: Date
}) {
  const [draft, setDraft] = useState("")
  const [projectId, setProjectId] = useState(
    projects.find((project) => project.id === selectedProjectId)?.id ?? projects[0]?.id ?? ""
  )
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const firstRun = !sessions?.some((session) => !session.archived)
  const submit = () => {
    if (draft.trim()) onStartWithPrompt?.(draft.trim(), projectId || undefined)
  }
  return (
    <div className="flex flex-1 flex-col bg-editor">
      <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-10">
        <div className="flex w-full max-w-[760px] flex-col gap-5">
          <h1 className="m-0 text-[20px] font-semibold tracking-[-0.2px] text-text-bright">
            {greetingFor(now, userName?.trim().split(/\s+/)[0])}
          </h1>

          <div className="flex flex-col gap-2">
            <Textarea
              ref={composerRef}
              aria-label="What should we build?"
              placeholder="What should we build?"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit()
              }}
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
              </ChipRow>
              <Button size="sm" disabled={!draft.trim() || !onStartWithPrompt} onClick={submit}>
                Start
              </Button>
            </div>
          </div>

          {firstRun && (
            <div className="flex flex-col" data-testid="home-starters">
              {STARTERS.map((label) => (
                <Button key={label} variant="ghost" onClick={onNewSession} className="w-full justify-start">
                  {label}
                </Button>
              ))}
              <Button variant="ghost" onClick={() => composerRef.current?.focus()} className="w-full justify-start">
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
      <span className="rounded-[3px] border border-line px-1.5 py-px font-mono text-muted-foreground">
        {keys}
      </span>
      {label}
    </span>
  )
}
