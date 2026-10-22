import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import type { ReviewFindingDraft, ReviewRun } from "@jingler/ui"
import { findingsToDrafts } from "./findings-to-drafts.js"
import { rpc } from "./rpc-client.js"

const E2E_KEY = "jingler:e2e-review-drafts"

/** Test-only fallback: drafts seeded in localStorage by the scripted e2e agent. */
function e2eDrafts(): ReadonlyArray<ReviewFindingDraft> | null {
  if (!window.jingler.isE2E) return null
  const raw = localStorage.getItem(E2E_KEY)
  return raw ? (JSON.parse(raw) as ReadonlyArray<ReviewFindingDraft>) : null
}

const NONE: ReadonlyArray<ReviewFindingDraft> = []

/**
 * Drafts for the Review drawer of the selected inbox PR. The read-only review starts on first
 * open (`onStart`) and its result is cached per `repo#number`, so drafts survive PR switches.
 */
export function useReviewDrafts(selected: { repository: string; number: number } | null) {
  const key = selected ? `${selected.repository}#${selected.number}` : ""
  const [started, setStarted] = useState<ReadonlySet<string>>(new Set())
  const seeded = useMemo(e2eDrafts, [])
  const query = useQuery({
    queryKey: ["review-draft-pr", key],
    queryFn: () => rpc.reviewDraftPr(selected!.repository, selected!.number),
    enabled: selected !== null && started.has(key) && seeded === null,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false
  })
  const drafts = useMemo(() => (query.data ? findingsToDrafts(query.data) : NONE), [query.data])
  if (seeded !== null) return { drafts: seeded, run: undefined }
  const status = query.isFetching ? "running" : query.isError ? "failed" : query.data ? "done" : "idle"
  const run: ReviewRun = {
    key,
    status,
    ...(query.isError ? { error: (query.error as { message?: string }).message ?? "The review failed" } : {}),
    onStart: () => (started.has(key) ? void query.refetch() : setStarted(new Set(started).add(key)))
  }
  return { drafts, run }
}
