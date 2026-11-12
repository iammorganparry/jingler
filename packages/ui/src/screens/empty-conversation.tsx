import { useRef } from "react"
import type { ComponentType, ReactNode } from "react"
import type { Session, SessionActivity } from "@jingler/core"
import { HomeCards } from "../composites/home-cards.js"
import { Button } from "../components/button.js"
import { Kbd } from "../components/kbd.js"
import type { ComposerVoiceInput } from "../composites/composer.js"

/**
 * Host component that owns dictation for Home's composer. Mounted only while Home shows, so its global
 * hold-to-talk key and 100ms level ticks stay out of the app root; `onText` updates the composer's text.
 */
export type HomeVoiceProvider = ComponentType<{
  onText: (update: (text: string) => string) => void
  children: (voice: ComposerVoiceInput) => ReactNode
}>

export const greetingFor = (now: Date, firstName?: string) => {
  const hour = now.getHours()
  const part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"
  return firstName ? `Good ${part}, ${firstName}` : `Good ${part}`
}

const STARTERS = [
  { label: "Start from a GitHub issue", source: "github" },
  { label: "Start from a PR", source: "pr" }
] as const

/**
 * Home (spec §5c) is New session: greeting, the New session composer (project/Auto,
 * source, model, mode), the starter rows on first run, then Needs you / Running
 * cards and the import card.
 */
export function EmptyConversation({
  version,
  composer,
  onStartFrom,
  userName,
  now = new Date(),
  sessions,
  liveActivity,
  onOpenSession,
  allowFor,
  importCard,
  today
}: {
  /** The New session composer (`NewWorkspaceView`), owned by the host. */
  composer?: ReactNode
  /** First-run starters: preselect a PR or GitHub issue source in the composer. */
  onStartFrom?: (source: "pr" | "github") => void
  /** Home › To Do + My PRs, owned by the host (null = none). */
  today?: ReactNode
  sessions?: ReadonlyArray<Session>
  liveActivity?: Record<string, SessionActivity>
  onOpenSession?: (sessionId: string) => void
  allowFor?: (sessionId: string) => (() => void) | undefined
  /** Home › the MCP import card, owned by the host (null = none). */
  importCard?: ReactNode
  version?: string
  /** Signed-in user's display name; only the first word is shown. */
  userName?: string
  now?: Date
}) {
  const composerRef = useRef<HTMLDivElement>(null)
  const firstRun = !sessions?.some((session) => !session.archived)
  const focusComposer = () => composerRef.current?.querySelector("textarea")?.focus()
  return (
    <div className="flex flex-1 flex-col bg-editor">
      <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 sm:px-10">
        <div className="flex w-full max-w-[760px] flex-col gap-5">
          <h1 className="m-0 text-[20px] font-semibold tracking-[-0.2px] text-text-bright">
            {greetingFor(now, userName?.trim().split(/\s+/)[0])}
          </h1>

          <div ref={composerRef} className="flex flex-col gap-2">{composer}</div>

          {firstRun && (
            <div className="flex flex-col" data-testid="home-starters">
              {STARTERS.map(({ label, source: from }) => (
                <Button
                  key={label}
                  variant="ghost"
                  onClick={() => (onStartFrom ? onStartFrom(from) : focusComposer())}
                  className="w-full justify-start"
                >
                  {label}
                </Button>
              ))}
              <Button variant="ghost" onClick={focusComposer} className="w-full justify-start">
                Describe a task
              </Button>
            </div>
          )}

          {sessions && liveActivity && onOpenSession ? (
            <HomeCards sessions={sessions} liveActivity={liveActivity} onOpenSession={onOpenSession} allowFor={allowFor} />
          ) : null}
          {today ?? null}
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
