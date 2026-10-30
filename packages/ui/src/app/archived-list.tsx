import * as React from "react"
import type { Session } from "@jingler/core"
import { activeCheckoutOf, hasNoRepo, UNTITLED_SESSION } from "@jingler/core"
import { Archive } from "lucide-react"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "../components/dialog.js"
import { SearchField } from "../components/search-input.js"
import { relativeTime } from "../lib/relative-time.js"
import { DEFAULT_FILTERS, filterSessions, sortSessions } from "./session-filters.js"

const ARCHIVED_ONLY = { ...DEFAULT_FILTERS, status: "archived" } as const

/** Archived sessions matching `query` (title, branch, repo), most recently archived first. */
export const searchArchived = (sessions: ReadonlyArray<Session>, query: string): ReadonlyArray<Session> =>
  sortSessions(filterSessions(sessions, query, ARCHIVED_ONLY), "recency", () => "idle")

function ArchivedRow({
  session,
  onRestore,
  onDelete
}: {
  session: Session
  onRestore?: (id: string) => void
  onDelete?: (id: string) => void
}) {
  const title = session.title || UNTITLED_SESSION
  const when = session.archivedAt ? relativeTime(session.archivedAt) : ""
  const checkout = activeCheckoutOf(session)
  return (
    <li
      data-testid={`archived-row-${session.id}`}
      className="flex items-center gap-3 border-b border-hairline py-2.5 last:border-b-0"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-text-bright">{title}</div>
        <div className="truncate font-mono text-[11px] text-dim">
          {hasNoRepo(checkout) ? "No repo" : `${checkout.repo} · ${checkout.branch}`}
          {when && ` · archived ${when}`}
        </div>
      </div>
      {onRestore && (
        <Button variant="secondary" size="sm" aria-label={`Restore ${title}`} onClick={() => onRestore(session.id)}>
          Restore
        </Button>
      )}
      {onDelete && (
        <Button variant="danger" size="sm" aria-label={`Delete ${title}`} onClick={() => onDelete(session.id)}>
          Delete
        </Button>
      )}
    </li>
  )
}

/**
 * The searchable Archived list. `onDelete` is destructive: the caller confirms
 * (a ConfirmDialog) before anything is removed, the same contract as the row quick-actions.
 */
export function ArchivedList({
  open,
  onOpenChange,
  sessions,
  onRestore,
  onDelete
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessions: ReadonlyArray<Session>
  onRestore?: (id: string) => void
  onDelete?: (id: string) => void
}) {
  const [query, setQuery] = React.useState("")
  const archived = React.useMemo(() => searchArchived(sessions, ""), [sessions])
  const matches = React.useMemo(() => searchArchived(sessions, query), [sessions, query])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[520px]">
        <DialogHeader>
          <DialogTitle>Archived ({archived.length})</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <DialogDescription className="sr-only">Restore an archived workspace or delete it for good.</DialogDescription>
          <SearchField value={query} onChange={setQuery} placeholder="Search archived…" autoFocus />
          {matches.length === 0 ? (
            <p className="py-6 text-center text-[12px] text-dim">
              {archived.length === 0 ? "No archived workspaces." : "No archived workspaces match."}
            </p>
          ) : (
            <ul className="max-h-[360px] overflow-auto">
              {matches.map((session) => (
                <ArchivedRow key={session.id} session={session} onRestore={onRestore} onDelete={onDelete} />
              ))}
            </ul>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

/** The sidebar's "Archived (N)" entry; opens the list. Absent while nothing is archived. */
export function ArchivedEntry({
  sessions,
  onRestore,
  onDelete
}: {
  sessions: ReadonlyArray<Session>
  onRestore?: (id: string) => void
  onDelete?: (id: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  const count = sessions.filter((session) => session.archived).length
  if (count === 0) return null
  return (
    <div className="px-2 pb-2">
      <Button
        variant="ghost"
        data-testid="archived-sidebar-item"
        className="h-9 w-full justify-start gap-2 px-2.5 text-[12px] font-semibold"
        onClick={() => setOpen(true)}
      >
        <Archive size={15} />
        <span className="flex-1 text-left">Archived</span>
        <Badge tone="count" size="xs">{count}</Badge>
      </Button>
      <ArchivedList open={open} onOpenChange={setOpen} sessions={sessions} onRestore={onRestore} onDelete={onDelete} />
    </div>
  )
}
