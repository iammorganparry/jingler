import * as React from "react"
import type { IssueSummary, PrSummary } from "@jingler/core"
import { CircleDot, Plug } from "lucide-react"
import { BannerShell } from "../components/banner-shell.js"
import { Button } from "../components/button.js"
import { EmptyState, InlineError, ListSkeleton } from "../components/feedback.js"
import { SearchInput } from "../components/search-input.js"
import { IssuePickerList } from "./issue-picker-list.js"
import { PrPickerList } from "./pr-picker-list.js"

export interface LinkedSessionRef {
  id: string
  title: string | null
}

export interface StartFromListProps {
  kind: "pr" | "issue"
  icon: React.ReactNode
  label: string
  search: string
  mine: boolean
  pullRequests: ReadonlyArray<PrSummary>
  issues: ReadonlyArray<IssueSummary>
  selectedPr: number | null
  selectedIssue: string | null
  loading: boolean
  /** Why the last load failed; null when it has not. */
  error: string | null
  /** False when the chosen issue provider is not installed/enabled. */
  providerConnected: boolean
  /** Live sessions already linked to the selected issue. */
  linkedSessions: ReadonlyArray<LinkedSessionRef>
  onSearch: (value: string) => void
  onMine: () => void
  onRetry: () => void
  onConnect?: () => void
  onOpenSession?: (id: string) => void
  onPr: React.ComponentProps<typeof PrPickerList>["onSelect"]
  onIssue: React.ComponentProps<typeof IssuePickerList>["onSelect"]
}

function AlreadyOpen({ linked, onOpen, onDismiss }: { linked: LinkedSessionRef; onOpen?: (id: string) => void; onDismiss: () => void }) {
  return (
    <BannerShell
      className="mx-3 mt-3"
      actions={[
        onOpen ? <Button key="open" size="sm" variant="secondary" onClick={() => onOpen(linked.id)}>Open it</Button> : <span key="n" />,
        <Button key="another" size="sm" variant="ghost" onClick={onDismiss}>Create another</Button>
      ]}
    >
      Already open in '{linked.title ?? "Untitled"}'
    </BannerShell>
  )
}

function IssueBody(props: StartFromListProps) {
  const { providerConnected, label, onConnect, loading, error, issues, mine, onMine, onRetry } = props
  if (!providerConnected) {
    return (
      <EmptyState
        icon={<Plug size={22} />}
        title={`${label.replace(/ issue$/i, "")} isn't connected`}
        action={onConnect && <Button size="sm" onClick={onConnect}>Connect</Button>}
      />
    )
  }
  if (loading) return <ListSkeleton rows={3} rowHeight={56} />
  if (error) return <InlineError message="Couldn't load issues" onRetry={onRetry} />
  if (issues.length === 0 && mine) {
    return <EmptyState icon={<CircleDot size={22} />} title="No assigned issues" action={<Button size="sm" variant="secondary" onClick={onMine}>Search all issues</Button>} />
  }
  return <IssuePickerList issues={issues} selected={props.selectedIssue} onSelect={props.onIssue} />
}

/** The "Start from" list: pull requests or provider issues with loading, empty, error and not-connected states. */
export function StartFromList(props: StartFromListProps) {
  const { kind, icon, label, search, mine, onSearch, onMine, providerConnected } = props
  const [dismissed, setDismissed] = React.useState<string | null | undefined>(undefined)
  const linked = props.linkedSessions[0]
  const showLinked = kind === "issue" && linked !== undefined && dismissed !== props.selectedIssue
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-panel" aria-label="Source picker">
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="text-text-bright">{icon}</span>
        <h3 className="text-[12px] font-semibold text-text-bright">{label}s</h3>
        <span className="text-[10.5px] text-dim">Choose one to prefill this session</span>
      </header>
      {providerConnected && (
        <div className="flex items-center gap-2 px-3 pt-3">
          <SearchInput value={search} onChange={onSearch} placeholder={kind === "pr" ? "Search pull requests…" : `Search ${label.toLowerCase()}s…`} className="flex-1" />
          <Button variant={mine ? "primary" : "secondary"} className="h-[34px]" aria-pressed={mine} onClick={onMine}>Just mine</Button>
        </div>
      )}
      {showLinked && <AlreadyOpen linked={linked} onOpen={props.onOpenSession} onDismiss={() => setDismissed(props.selectedIssue)} />}
      <div className="p-3">
        {kind === "pr"
          ? <PrPickerList prs={props.pullRequests} selected={props.selectedPr} onSelect={props.onPr} loading={props.loading} />
          : <IssueBody {...props} />}
      </div>
    </section>
  )
}
