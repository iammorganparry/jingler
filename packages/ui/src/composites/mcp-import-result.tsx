import { Check } from "lucide-react"
import { Button } from "../components/button.js"
import { StatusRow } from "../components/status-row.js"

export interface McpImportResultRow {
  readonly name: string
  /** `imported` = ready; `needs-auth` = OAuth sign-in pending; `failed` = probe could not start it. */
  readonly status: "imported" | "needs-auth" | "failed"
}

/** Import result step: neutral rows; only a failed row is red and offers its log; OAuth rows offer Connect. */
export function McpImportResult({
  rows,
  onConnect,
  onViewLog
}: {
  readonly rows: ReadonlyArray<McpImportResultRow>
  readonly onConnect: (name: string) => void
  readonly onViewLog: (name: string) => void
}) {
  return (
    <div className="max-h-64 overflow-auto rounded-xl border border-line bg-sunken">
      {rows.map(({ name, status }) => (
        <div key={name} className="flex items-center justify-between gap-3 border-b border-line px-3.5 py-2.5 last:border-b-0">
          <div className="min-w-0 space-y-0.5">
            <div className="truncate text-xs font-medium text-text-bright">{name}</div>
            {status === "failed" ? (
              <StatusRow failed>Failed to start</StatusRow>
            ) : status === "needs-auth" ? (
              <StatusRow>Needs sign-in</StatusRow>
            ) : (
              <StatusRow icon={<Check size={12} />}>Imported</StatusRow>
            )}
          </div>
          {status === "failed" && (
            <Button variant="ghost" size="sm" onClick={() => onViewLog(name)}>
              View log
            </Button>
          )}
          {status === "needs-auth" && (
            <Button variant="secondary" size="sm" onClick={() => onConnect(name)}>
              Connect
            </Button>
          )}
        </div>
      ))}
    </div>
  )
}
