import type { PlanAcceptanceStatus, PlanDocument } from "@jingler/core"
import { AlertTriangle, Check, Cloud, RefreshCw, Save, WifiOff } from "lucide-react"
import { useState } from "react"
import { Button } from "../components/button.js"
import { SegmentedControl } from "../components/segmented-control.js"
import { cn } from "../lib/cn.js"
import { PlanMdx } from "../components/plan-mdx.js"

export type PlanEditorMode = "rendered" | "source" | "split"
export type PlanEditorSyncState =
  | "loading"
  | "clean"
  | "editing"
  | "saving"
  | "conflict"
  | "error"

const SYNC: Record<
  PlanEditorSyncState,
  { readonly label: string; readonly className: string; readonly icon: typeof Cloud }
> = {
  loading: { label: "Loading", className: "text-muted-foreground", icon: RefreshCw },
  clean: { label: "Synced", className: "text-green", icon: Check },
  editing: { label: "Editing", className: "text-yellow", icon: Cloud },
  saving: { label: "Saving", className: "text-blue", icon: RefreshCw },
  conflict: { label: "Conflict", className: "text-red", icon: AlertTriangle },
  error: { label: "Save failed", className: "text-red", icon: WifiOff }
}

export function PlanEditor({
  document,
  draft,
  remote,
  state,
  error,
  compact = false,
  onEdit,
  onSave,
  onRetry,
  onKeepLocal,
  onAcceptRemote,
  onCriterionChange,
  onAnnotate
}: {
  document: PlanDocument
  draft: string
  remote?: PlanDocument | null
  state: PlanEditorSyncState
  error?: string | null
  compact?: boolean
  onEdit?: (source: string) => void
  onSave?: () => void
  onRetry?: () => void
  onKeepLocal?: () => void
  onAcceptRemote?: () => void
  onCriterionChange?: (
    criterionId: string,
    status: PlanAcceptanceStatus,
    evidence: string | null
  ) => void
  onAnnotate?: (stageId: string | null, body: string) => void
}) {
  const [mode, setMode] = useState<PlanEditorMode>(compact ? "rendered" : "split")
  const sync = SYNC[state]
  const SyncIcon = sync.icon
  const source = (
    <textarea
      aria-label="Plan MDX source"
      value={draft}
      onChange={(event) => onEdit?.(event.target.value)}
      spellCheck={false}
      className="h-full min-h-[360px] w-full resize-none bg-editor p-4 font-mono text-[11.5px] leading-[1.65] text-text-body outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    />
  )
  const rendered = (
    <div className="h-full overflow-auto bg-editor">
      <PlanMdx
        document={document}
        disabled={state === "conflict"}
        onCriterionChange={onCriterionChange}
        onAnnotate={onAnnotate}
      />
    </div>
  )

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-none flex-wrap items-center gap-2 border-b border-hairline bg-panel px-3 py-2">
        <SegmentedControl
          value={mode}
          onChange={setMode}
          items={[
            { value: "rendered", label: "Rendered" },
            { value: "source", label: "Source" },
            { value: "split", label: "Split", disabled: compact }
          ]}
        />
        <span
          role="status"
          aria-live="polite"
          className={cn("ml-auto flex items-center gap-1.5 text-[10.5px] font-medium", sync.className)}
        >
          <SyncIcon className={cn("size-3.5", state === "saving" && "animate-spin")} />
          {sync.label}
        </span>
        {(state === "editing" || state === "error") && (
          <Button
            variant="secondary"
            size="sm"
            onClick={state === "error" ? onRetry : onSave}
          >
            {state === "error" ? <RefreshCw className="size-3.5" /> : <Save className="size-3.5" />}
            {state === "error" ? "Retry" : "Save now"}
          </Button>
        )}
      </div>

      {state === "conflict" && remote ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-2 border-b border-red/30 bg-red/5 px-4 py-3">
            <AlertTriangle className="size-4 text-red" />
            <p className="min-w-0 flex-1 text-[11.5px] text-text-body">
              Revision {remote.revision} arrived while this draft had local edits. Both versions are preserved.
            </p>
            <Button variant="secondary" size="sm" onClick={onAcceptRemote}>Use remote</Button>
            <Button size="sm" onClick={onKeepLocal}>Keep local and save</Button>
          </div>
          <div className="grid min-h-0 flex-1 divide-x divide-line lg:grid-cols-2">
            <section className="flex min-h-0 flex-col">
              <p className="border-b border-line px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-yellow">
                Local draft
              </p>
              {source}
            </section>
            <section className="flex min-h-0 flex-col">
              <p className="border-b border-line px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-blue">
                Remote revision {remote.revision}
              </p>
              <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap bg-sunken p-4 font-mono text-[11.5px] leading-[1.65] text-text-body">
                {remote.source}
              </pre>
            </section>
          </div>
        </div>
      ) : (
        <>
          {state === "error" && error && (
            <div role="alert" className="flex-none border-b border-red/30 bg-red/5 px-4 py-2 text-[11px] text-red">
              {error}
            </div>
          )}
          <div className="min-h-0 flex-1">
            {mode === "rendered" && rendered}
            {mode === "source" && source}
            {mode === "split" && (
              <div className="grid h-full min-h-0 divide-x divide-line xl:grid-cols-2">
                <div className="min-h-0 overflow-hidden">{source}</div>
                <div className="min-h-0 overflow-hidden">{rendered}</div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
