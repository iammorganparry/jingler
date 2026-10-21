import { useEffect, useState } from "react"
import type { Session, SessionActivity } from "@jingler/core"
import { deriveHomeCards } from "./home-cards-model.js"
import { Button } from "../components/button.js"
import { Card } from "../components/card.js"
import { StatusRow } from "../components/status-row.js"

/** Home › a run blocked on the operator. A stale card (no longer pending) turns neutral and only dismisses. */
export function NeedsYouCard({
  title,
  text,
  stale = false,
  onAllow,
  onAnswer,
  onDismiss
}: {
  readonly title: string
  readonly text: string
  readonly stale?: boolean
  readonly onAllow?: () => void
  readonly onAnswer: () => void
  readonly onDismiss: () => void
}) {
  return (
    <Card className="px-4 py-3">
      <div className="text-[11px] text-dim">{title}</div>
      {stale ? (
        <StatusRow className="mt-1">
          No longer waiting · <Button variant="ghost" size="sm" onClick={onDismiss} className="inline h-auto px-0 py-0 hover:bg-transparent hover:underline">Dismiss</Button>
        </StatusRow>
      ) : (
        <>
          <p className="mt-1 text-[13px] text-text-bright">{text}</p>
          <div className="mt-2 flex items-center gap-2">
            {onAllow ? <Button size="sm" onClick={onAllow}>Allow</Button> : null}
            <Button size="sm" variant="secondary" onClick={onAnswer}>Answer</Button>
          </div>
        </>
      )}
    </Card>
  )
}

/** Home › one session that is working right now. */
export function RunningRow({ title, activity, onOpen }: { readonly title: string; readonly activity: string; readonly onOpen: () => void }) {
  return (
    <Button variant="ghost" onClick={onOpen} className="w-full justify-between">
      <span className="truncate">{title}</span>
      <span className="truncate text-[12px] text-dim">{activity}</span>
    </Button>
  )
}

/** Home › needs-you cards then running rows, derived from live activities; remembers cards it showed so they can go stale. */
export function HomeCards({
  sessions,
  liveActivity,
  onOpenSession
}: {
  readonly sessions: ReadonlyArray<Session>
  readonly liveActivity: Readonly<Record<string, SessionActivity>>
  readonly onOpenSession: (sessionId: string) => void
}) {
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set())
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const { needsYou, running } = deriveHomeCards({ sessions, liveActivity, seen, dismissed })
  useEffect(() => {
    const fresh = needsYou.filter((card) => !card.stale && !seen.has(card.sessionId))
    if (fresh.length === 0) return
    setSeen((prev) => new Set([...prev, ...fresh.map((card) => card.sessionId)]))
    // A new question after a dismissal must show again.
    setDismissed((prev) => new Set([...prev].filter((id) => !fresh.some((card) => card.sessionId === id))))
  }, [needsYou, seen])
  const dismiss = (id: string) => setDismissed((prev) => new Set(prev).add(id))
  if (needsYou.length === 0 && running.length === 0) return null
  return (
    <div className="flex w-full max-w-[452px] flex-col gap-2 text-left" data-testid="home-cards">
      {needsYou.map((card) => (
        <NeedsYouCard
          key={card.sessionId}
          title={card.title}
          text={card.text}
          stale={card.stale}
          onAnswer={() => onOpenSession(card.sessionId)}
          onDismiss={() => dismiss(card.sessionId)}
        />
      ))}
      {running.map((row) => (
        <RunningRow key={row.sessionId} title={row.title} activity={row.activity} onOpen={() => onOpenSession(row.sessionId)} />
      ))}
    </div>
  )
}
