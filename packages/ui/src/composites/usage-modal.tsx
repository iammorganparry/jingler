import { Spin } from "../components/spin.js"
import type { Usage, UsageReport } from "@jingler/core"
import { Gauge, RefreshCw } from "lucide-react"
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/dialog.js"
import { fmtUpdated, UsageBody } from "./usage-panel.js"

/**
 * The Usage & limits modal: per-provider session/weekly windows as status-tinted
 * bars. Provider connections report usage through their pinned authentication
 * route; connections without a usage endpoint show as unavailable.
 */
export function UsageModal({
  open,
  usage,
  report,
  loading = false,
  onExport,
  onClose
}: {
  open: boolean
  usage?: Usage | null
  report?: UsageReport | null
  /** A usage fetch is in flight (the live read takes a couple of seconds). */
  loading?: boolean
  onExport?: () => Promise<void> | void
  onClose?: () => void
}) {
  const hasProviders = (usage?.providers.length ?? 0) > 0
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose?.()}>
      <DialogContent className="w-[720px] max-w-[calc(100vw-48px)]">
        <DialogHeader>
          <Gauge size={16} className="text-blue" />
          <DialogTitle>Usage &amp; limits</DialogTitle>
        </DialogHeader>
        <DialogBody className="py-0">
          <UsageBody usage={usage} report={report} loading={loading} onExport={onExport} />
        </DialogBody>
        <DialogFooter className="justify-start text-[11px] text-muted-foreground">
          <Spin active={loading}><RefreshCw size={12} /></Spin>
          {loading && hasProviders ? "Refreshing…" : `Last updated: ${fmtUpdated(usage?.fetchedAt ?? null)}`}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
