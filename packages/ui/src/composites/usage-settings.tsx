import type { Usage, UsageReport } from "@jingler/core"
import { fmtUpdated, UsageBody } from "./usage-panel.js"

export interface UsageSettingsProps {
  usage?: Usage | null
  report?: UsageReport | null
  loading?: boolean
  onExport?: () => Promise<void> | void
  /** Fetch fresh usage; called when the page opens. */
  onOpen?: () => void
}

/** Settings › Workspace › Usage: the Usage & limits content as a full page (spec §5l, board 18b). */
export function UsageSettings({ usage, report, loading = false, onExport }: UsageSettingsProps) {
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-editor p-6">
      <div className="flex w-full max-w-[720px] flex-col">
        <h2 className="text-[20px] font-semibold text-text-bright">Usage</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">Plan limits per provider and the execution report.</p>
        <div className="mt-2" data-testid="usage-page">
          <UsageBody usage={usage} report={report} loading={loading} onExport={onExport} />
        </div>
        <div className="pt-3 text-[11px] text-muted-foreground">
          {loading ? "Refreshing…" : `Last updated: ${fmtUpdated(usage?.fetchedAt ?? null)}`}
        </div>
      </div>
    </div>
  )
}
