import type { RuntimeDiagnosticSnapshot } from "@jingler/core"
import { Activity } from "lucide-react"
import { Button } from "../components/button.js"
import { SettingsCard, SettingsRow } from "../components/settings-row.js"
import { cn } from "../lib/cn.js"

export interface RuntimeInspectorProps {
  readonly snapshot: RuntimeDiagnosticSnapshot | null
  readonly loading: boolean
  readonly exported?: boolean
  readonly error?: string | null
  readonly onRefresh: () => void
  readonly onExport: () => void
}

const Value = ({ mono = false, children }: { mono?: boolean; children: string }) => (
  <span className={cn("max-w-[320px] break-words text-right text-[12px] text-text-bright", mono && "font-mono")}>{children}</span>
)

export function RuntimeInspector({ snapshot, loading, exported = false, error, onRefresh, onExport }: RuntimeInspectorProps) {
  return (
    <section aria-label="Runtime inspector" className="flex min-w-0 flex-1 flex-col overflow-auto bg-editor p-6 text-text">
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-6">
        <div className="flex items-center gap-2 border-b border-hairline pb-2.5">
          <Activity size={14} className="text-text-bright" />
          <h2 className="text-[13px] font-semibold text-text-bright">Runtime inspector</h2>
        </div>
        <SettingsCard title="Actions">
          <SettingsRow
            label="Contract metadata"
            help="Contract metadata only. Prompts, arguments, patches, and reasoning are excluded."
            control={<Button variant="secondary" size="sm" onClick={onRefresh}>Refresh</Button>}
          />
          <SettingsRow
            label="Diagnostic bundle"
            help="Export a redacted bundle for the latest run."
            control={<Button variant="secondary" size="sm" onClick={onExport} disabled={snapshot === null}>Export diagnostics</Button>}
          />
        </SettingsCard>
        {loading && <p className="text-xs text-muted-foreground">Loading runtime metadata…</p>}
        {error && <p role="alert" className="text-xs text-state-failed">{error}</p>}
        {exported && <p role="status" className="text-xs text-muted-foreground">Redacted diagnostic bundle prepared.</p>}
        {!loading && snapshot === null && !error && (
          <p className="text-xs text-muted-foreground">No pi runtime diagnostics have been recorded yet.</p>
        )}
        {snapshot && (
          <SettingsCard title="Diagnostics">
            <SettingsRow label="Run" control={<Value>{snapshot.runId}</Value>} />
            <SettingsRow label="Authentication" control={<Value>{snapshot.authRoute ?? "Not resolved"}</Value>} />
            <SettingsRow label="Prompt" control={<Value>{snapshot.promptHash}</Value>} />
            <SettingsRow
              label="Contracts"
              control={<Value mono>{`prompt ${snapshot.versions.prompt} · tools ${snapshot.versions.tools} · diff ${snapshot.versions.diff} · pi ${snapshot.versions.piSdk}`}</Value>}
            />
            <SettingsRow label="Tools" control={<Value>{snapshot.activeToolIds.join(", ") || "None"}</Value>} />
            <SettingsRow
              label="Mutations"
              control={<Value>{snapshot.mutations.map(({ toolId, status }) => `${toolId}: ${status}`).join(", ") || "None"}</Value>}
            />
            <SettingsRow label="File changes" control={<Value>{snapshot.fileChangeStatuses.join(", ") || "None"}</Value>} />
            <SettingsRow
              label="MCP"
              control={<Value>{snapshot.mcpHealth.map(({ name, status }) => `${name}: ${status}`).join(", ") || "None"}</Value>}
            />
            <SettingsRow label="Terminal cause" control={<Value>{snapshot.terminalCause ?? "Running"}</Value>} />
          </SettingsCard>
        )}
      </div>
    </section>
  )
}
