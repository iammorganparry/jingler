import type { ImportableSession } from "@jingler/core"
import { Button } from "../components/button.js"
import { Checkbox } from "../components/checkbox.js"
import { EmptyState, InlineError, ListSkeleton } from "../components/feedback.js"
import { SearchField } from "../components/search-input.js"

export type ImportSessionsStatus = "loading" | "ready" | "error"

export interface ImportSessionsListProps {
  candidates: ReadonlyArray<ImportableSession>
  status: ImportSessionsStatus
  error?: string
  query: string
  onQueryChange: (query: string) => void
  /** Keys produced by `importSessionKey`. */
  selected: ReadonlySet<string>
  onToggle: (key: string) => void
  onImport: () => void
  onSkip: () => void
  onRetry: () => void
}

const SOURCE_LABELS: Record<ImportableSession["source"], string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  conductor: "Conductor",
  t3code: "T3 Code"
}

export const importSessionKey = (session: Pick<ImportableSession, "source" | "nativeSessionId">): string =>
  `${session.source}:${session.nativeSessionId}`

const repoName = (cwd: string): string => cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd

const matchesQuery = (session: ImportableSession, query: string): boolean => {
  const needle = query.trim().toLowerCase()
  return needle === "" || `${session.title} ${repoName(session.cwd)}`.toLowerCase().includes(needle)
}

const groupBySource = (sessions: ReadonlyArray<ImportableSession>) => {
  const groups = new Map<ImportableSession["source"], ImportableSession[]>()
  for (const session of sessions) groups.set(session.source, [...(groups.get(session.source) ?? []), session])
  return [...groups]
}

function SessionRow({
  session,
  checked,
  onToggle
}: {
  session: ImportableSession
  checked: boolean
  onToggle: (key: string) => void
}) {
  const key = importSessionKey(session)
  const imported = session.alreadyImported === true
  const detail = [repoName(session.cwd), session.branch].filter(Boolean).join(" · ")
  return (
    <li className="flex h-10 items-center gap-3 px-2" data-testid="import-session-row">
      <Checkbox
        aria-label={`Select ${session.title}`}
        checked={checked}
        disabled={imported}
        onCheckedChange={() => onToggle(key)}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-text-bright">{session.title}</span>
        <span className="block truncate text-[11px] text-dim">{detail}</span>
      </span>
      {!session.folderExists && <span className="flex-none text-[11px] text-state-failed">Folder missing</span>}
      {imported && <span className="flex-none text-[11px] text-dim">Imported</span>}
    </li>
  )
}

function Groups({
  sessions,
  selected,
  onToggle
}: {
  sessions: ReadonlyArray<ImportableSession>
  selected: ReadonlySet<string>
  onToggle: (key: string) => void
}) {
  return (
    <div className="flex flex-col gap-3">
      {groupBySource(sessions).map(([source, group]) => (
        <section key={source} aria-label={SOURCE_LABELS[source]}>
          <h3 className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {SOURCE_LABELS[source]} <span className="text-dim">{group.length}</span>
          </h3>
          <ul>
            {group.map((session) => (
              <SessionRow
                key={importSessionKey(session)}
                session={session}
                checked={selected.has(importSessionKey(session))}
                onToggle={onToggle}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** Onboarding/sidebar step: pick sessions found in other apps to import. Presentational only. */
export function ImportSessionsList(props: ImportSessionsListProps) {
  const { candidates, status, error, query, onQueryChange, selected, onToggle, onImport, onSkip, onRetry } = props
  const visible = candidates.filter((session) => matchesQuery(session, query))
  const count = selected.size

  function renderBody() {
    if (status === "loading") return <ListSkeleton rows={4} rowHeight={40} />
    if (status === "error") return <InlineError message={error ?? "Could not scan for sessions."} onRetry={onRetry} />
    if (visible.length === 0) return <EmptyState title="No sessions found" />
    return <Groups sessions={visible} selected={selected} onToggle={onToggle} />
  }

  return (
    <div className="flex w-full max-w-[520px] flex-col gap-3 rounded-lg border border-line bg-panel p-4">
      <SearchField value={query} onChange={onQueryChange} placeholder="Filter by title or repo" />
      <div className="max-h-[360px] min-h-[120px] overflow-y-auto">{renderBody()}</div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onSkip}>
          Skip
        </Button>
        <Button disabled={count === 0} onClick={onImport}>
          {`Import ${count} ${count === 1 ? "session" : "sessions"}`}
        </Button>
      </div>
    </div>
  )
}
