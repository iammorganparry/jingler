import type { RuntimeDiagnosticSnapshot } from "@jingler/core"

export interface RuntimeInspectorProps {
  readonly snapshot: RuntimeDiagnosticSnapshot | null
  readonly loading: boolean
  readonly error?: string | null
  readonly onRefresh: () => void
  readonly onExport: () => void
}

export function RuntimeInspector({ snapshot, loading, error, onRefresh, onExport }: RuntimeInspectorProps) {
  return (
    <section aria-label="Runtime inspector" className="flex min-h-0 flex-1 flex-col gap-3 bg-editor p-4 text-text">
      <header className="flex items-center justify-between border-b border-hairline pb-3">
        <div>
          <h2 className="text-sm font-semibold">Runtime inspector</h2>
          <p className="text-xs text-muted-foreground">Contract metadata only. Prompts, arguments, patches, and reasoning are excluded.</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={onRefresh} className="rounded border border-hairline bg-panel px-3 py-1.5 text-xs">Refresh</button>
          <button type="button" onClick={onExport} disabled={snapshot === null} className="rounded border border-hairline bg-panel px-3 py-1.5 text-xs disabled:opacity-50">Export diagnostics</button>
        </div>
      </header>
      {loading && <p className="text-xs text-muted-foreground">Loading runtime metadata…</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {snapshot && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-xs">
          <dt className="text-muted-foreground">Run</dt><dd>{snapshot.runId}</dd>
          <dt className="text-muted-foreground">Authentication</dt><dd>{snapshot.authRoute ?? "Not resolved"}</dd>
          <dt className="text-muted-foreground">Prompt</dt><dd>{snapshot.promptHash}</dd>
          <dt className="text-muted-foreground">Tools</dt><dd>{snapshot.activeToolIds.join(", ") || "None"}</dd>
          <dt className="text-muted-foreground">File changes</dt><dd>{snapshot.fileChangeStatuses.join(", ") || "None"}</dd>
          <dt className="text-muted-foreground">Terminal cause</dt><dd>{snapshot.terminalCause ?? "Running"}</dd>
        </dl>
      )}
    </section>
  )
}
