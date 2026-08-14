import type { DetectedResourceCandidate, ResourceDetectionResult } from "@jingler/core"
import { Boxes, Check, Search, SkipForward } from "lucide-react"
import { useMemo, useState } from "react"
import { Button } from "../../components/button.js"
import { Callout } from "../../components/callout.js"
import { Eyebrow } from "../../components/eyebrow.js"
import { Input } from "../../components/input.js"
import { Spinner } from "../../components/loading.js"

export interface ResourceSetupStepProps {
  detection: ResourceDetectionResult | null
  busy: boolean
  error: string | null
  onImport: (candidates: ReadonlyArray<DetectedResourceCandidate>) => void
  onSkip: () => void
  onCancel: () => void
  onRetry: () => void
}

export function ResourceSetupStep({ detection, busy, error, onImport, onSkip, onCancel, onRetry }: ResourceSetupStepProps) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(detection?.candidates.map(({ id }) => id) ?? [])
  )
  const [query, setQuery] = useState("")
  const candidates = detection?.candidates ?? []
  const chosen = candidates.filter(({ id }) => selected.has(id))
  const visibleCandidates = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (normalized.length === 0) return candidates
    return candidates.filter((candidate) =>
      [
        candidate.name,
        candidate.kind,
        candidate.description,
        candidate.provenance.sourcePath
      ].some((value) => value.toLowerCase().includes(normalized))
    )
  }, [candidates, query])

  return (
    <>
      <div className="flex flex-col gap-2.5">
        <Eyebrow>Welcome · 4 of 4</Eyebrow>
        <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-text-bright">Import agent resources</h1>
        <p className="text-[13px] leading-[1.6] text-muted-foreground">
          Jingler found these skills and prompts but has not loaded them. Review and explicitly import only what you trust.
        </p>
      </div>

      {error && <Callout tone="red"><div className="flex items-center justify-between gap-3"><span>{error}</span><Button variant="ghost" size="sm" onClick={onRetry}>Retry</Button></div></Callout>}

      {detection === null ? (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground"><Spinner size={13} /> Detecting resources…</div>
      ) : candidates.length === 0 ? (
        <div className="rounded-lg border border-line bg-sunken p-4 text-[12px] text-muted-foreground">No importable resources were detected.</div>
      ) : (
        <div className="flex flex-col overflow-hidden rounded-lg border border-line bg-sunken">
          <div className="flex items-center gap-2 border-b border-line p-2">
            <Search size={13} className="ml-1 shrink-0 text-dim" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              type="search"
              placeholder="Search skills and prompts"
              aria-label="Search agent resources"
              className="h-8 border-0 bg-transparent px-1 shadow-none"
            />
            <span className="shrink-0 px-1 font-mono text-[10px] text-dim">
              {visibleCandidates.length} of {candidates.length}
            </span>
          </div>
          <div
            data-testid="resource-candidate-list"
            className="flex max-h-[min(480px,45vh)] flex-col gap-1 overflow-y-auto p-2"
          >
            {visibleCandidates.map((candidate) => {
              const checked = selected.has(candidate.id)
              return (
                <button
                  key={candidate.id}
                  type="button"
                  className="flex min-h-12 shrink-0 items-start gap-3 rounded-md px-2 py-2 text-left hover:bg-hover"
                  onClick={() => setSelected((current) => {
                    const next = new Set(current)
                    if (next.has(candidate.id)) next.delete(candidate.id)
                    else next.add(candidate.id)
                    return next
                  })}
                >
                  <span className="mt-0.5 flex size-4 items-center justify-center rounded border border-line-strong bg-canvas text-green">{checked && <Check size={12} />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] font-medium text-text-body">{candidate.name}</span>
                    <span className="block truncate font-mono text-[10px] text-dim">{candidate.kind} · {candidate.provenance.sourcePath}</span>
                  </span>
                </button>
              )
            })}
            {visibleCandidates.length === 0 && (
              <div className="px-3 py-6 text-center text-[11.5px] text-muted-foreground">
                No resources match “{query.trim()}”.
              </div>
            )}
          </div>
        </div>
      )}

      {detection && detection.skipped.length > 0 && (
        <p className="text-[11px] text-dim">{detection.skipped.length} malformed or unsupported resource{detection.skipped.length === 1 ? " was" : "s were"} skipped.</p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy || chosen.length === 0} onClick={() => onImport(chosen)}>
          {busy ? <Spinner size={13} /> : <Boxes size={14} />} Import selected
        </Button>
        <Button variant="secondary" disabled={busy || candidates.length === 0} onClick={() => onImport(candidates)}>
          <Boxes size={14} /> Import all
        </Button>
        {busy ? (
          <Button variant="ghost" onClick={onCancel}>Cancel import</Button>
        ) : (
          <Button variant="ghost" onClick={onSkip}><SkipForward size={13} /> Skip for now</Button>
        )}
      </div>
    </>
  )
}
