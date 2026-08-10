import type {
  DetectedResourceCandidate,
  ManagedResource,
  ManagedResourceId,
  ResourceDetectionResult
} from "@jingler/core"
import { Boxes, Check, FolderOpen, RefreshCw, Trash2 } from "lucide-react"
import { Button } from "../components/button.js"
import { Callout } from "../components/callout.js"
import { Toggle } from "../components/toggle.js"

export interface AgentsSettingsProps {
  readonly resources: ReadonlyArray<ManagedResource>
  readonly detection: ResourceDetectionResult | null
  readonly selectedCandidateIds: ReadonlySet<string>
  readonly loading: boolean
  readonly reviewing: boolean
  readonly error?: string | null
  readonly onDetect: () => void
  readonly onToggleCandidate: (id: string) => void
  readonly onImportSelected: () => void
  readonly onCancelDetection: () => void
  readonly onSetEnabled: (id: ManagedResourceId, enabled: boolean) => void
  readonly onReveal: (id: ManagedResourceId) => void
  readonly onRemove: (id: ManagedResourceId) => void
  readonly onRetry: () => void
}

const scopeLabel = (resource: ManagedResource): string =>
  resource.scope.kind === "device-local"
    ? `Device · ${resource.scope.targetId}`
    : resource.scope.allowedTargets.length === 0
      ? "Portable · all targets"
      : `Portable · ${resource.scope.allowedTargets.join(", ")}`

function CandidateRow({
  candidate,
  selected,
  onToggle
}: {
  readonly candidate: DetectedResourceCandidate
  readonly selected: boolean
  readonly onToggle: () => void
}) {
  return (
    <button
      type="button"
      className="flex w-full items-start gap-3 rounded-md px-3 py-2 text-left hover:bg-hover"
      onClick={onToggle}
    >
      <span className="mt-0.5 flex size-4 items-center justify-center rounded border border-line-strong bg-canvas text-green">
        {selected && <Check size={12} />}
      </span>
      <span className="min-w-0 flex-1">
        <strong className="block text-[12px] text-text-bright">{candidate.name}</strong>
        <span className="block truncate font-mono text-[10px] text-dim">
          {candidate.kind} · {candidate.provenance.sourcePath}
        </span>
      </span>
    </button>
  )
}

export function AgentsSettings(props: AgentsSettingsProps) {
  const selectedCount = props.detection?.candidates.filter(({ id }) =>
    props.selectedCandidateIds.has(id)
  ).length ?? 0

  return (
    <section aria-label="Agents and skills" className="flex min-w-0 flex-1 flex-col overflow-auto bg-editor p-6 text-text">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[16px] font-semibold text-text-bright">Agents &amp; skills</h2>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Only explicitly imported resources are available to Jingler agents.
            </p>
          </div>
          <Button size="sm" onClick={props.onDetect} disabled={props.loading || props.reviewing}>
            <RefreshCw size={13} /> Detect resources
          </Button>
        </header>

        {props.error && (
          <Callout tone="red">
            <div className="flex items-center justify-between gap-3">
              <span>{props.error}</span>
              <Button variant="ghost" size="sm" onClick={props.onRetry}>Retry</Button>
            </div>
          </Callout>
        )}

        {props.reviewing && props.detection && (
          <div className="rounded-lg border border-blue/40 bg-blue/5 p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <strong className="text-[12px] text-text-bright">Review detected resources</strong>
                <p className="text-[10.5px] text-muted-foreground">Detection never loads or copies these files.</p>
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={props.onCancelDetection}>Cancel</Button>
                <Button size="sm" disabled={selectedCount === 0} onClick={props.onImportSelected}>
                  <Boxes size={13} /> Import {selectedCount || "selected"}
                </Button>
              </div>
            </div>
            <div className="max-h-60 overflow-auto rounded-md border border-line bg-sunken p-1">
              {props.detection.candidates.length === 0 ? (
                <p className="px-3 py-5 text-center text-[11px] text-muted-foreground">No importable resources detected.</p>
              ) : props.detection.candidates.map((candidate) => (
                <CandidateRow
                  key={candidate.id}
                  candidate={candidate}
                  selected={props.selectedCandidateIds.has(candidate.id)}
                  onToggle={() => props.onToggleCandidate(candidate.id)}
                />
              ))}
            </div>
            {props.detection.skipped.length > 0 && (
              <p className="mt-2 text-[10.5px] text-yellow">
                {props.detection.skipped.length} malformed or unsupported resource entries were skipped.
              </p>
            )}
          </div>
        )}

        <div className="overflow-hidden rounded-lg border border-line bg-panel">
          {props.loading && props.resources.length === 0 ? (
            <p className="px-4 py-10 text-center text-[12px] text-muted-foreground">Loading managed resources…</p>
          ) : props.resources.length === 0 ? (
            <p className="px-4 py-10 text-center text-[12px] text-muted-foreground">No managed resources imported.</p>
          ) : props.resources.map((resource) => (
            <div key={resource.id} className="flex items-center gap-3 border-b border-hairline px-4 py-3 last:border-b-0">
              <span className="flex size-9 items-center justify-center rounded-md bg-sunken text-blue"><Boxes size={17} /></span>
              <div className="min-w-0 flex-1">
                <strong className="block truncate text-[12px] text-text-bright">{resource.name}</strong>
                <span className="text-[10px] text-muted-foreground">{resource.kind} · {scopeLabel(resource)} · {resource.trust}</span>
              </div>
              <Toggle
                checked={resource.enabled}
                onCheckedChange={(enabled) => props.onSetEnabled(resource.id, enabled)}
                aria-label={`${resource.enabled ? "Disable" : "Enable"} ${resource.name}`}
                disabled={props.loading}
              />
              {resource.kind !== "mcp" && (
                <Button variant="ghost" size="sm" onClick={() => props.onReveal(resource.id)} disabled={props.loading}>
                  <FolderOpen size={13} /> Reveal
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => props.onRemove(resource.id)} disabled={props.loading}>
                <Trash2 size={13} /> Remove
              </Button>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
