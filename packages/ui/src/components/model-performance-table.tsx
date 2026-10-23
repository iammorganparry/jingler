import type { ModelPerformanceSortKey, UsageReportGroup } from "@jingler/core"
import { cn } from "../lib/cn.js"

const columns: ReadonlyArray<{
  key: ModelPerformanceSortKey
  label: string
  format: (group: UsageReportGroup) => string
}> = [
  { key: "modelId", label: "Model", format: (g) => g.modelId },
  { key: "runCount", label: "Runs", format: (g) => String(g.runCount) },
  { key: "successRate", label: "Success", format: (g) => (g.successRate == null ? "—" : `${Math.round(g.successRate * 100)}%`) },
  { key: "durationMs", label: "Duration", format: (g) => `${Math.round(g.durationMs / 1000)}s` },
  { key: "totalTokens", label: "Tokens", format: (g) => g.totalTokens.toLocaleString() },
  { key: "knownCostUsd", label: "Cost", format: (g) => (g.costCoverage === 1 ? `$${g.knownCostUsd.toFixed(2)}` : `$${g.knownCostUsd.toFixed(2)} partial`) }
]

/** Per-model performance rows, sortable by any column via a shared `sortModelPerformance`. */
export function ModelPerformanceTable({
  groups,
  sortBy,
  direction,
  onSort,
  onRowClick,
  className
}: {
  groups: ReadonlyArray<UsageReportGroup>
  sortBy: ModelPerformanceSortKey
  direction: "asc" | "desc"
  onSort: (key: ModelPerformanceSortKey) => void
  /** Opens the model detail drawer for that row; rows render as plain data when omitted. */
  onRowClick?: (group: UsageReportGroup) => void
  className?: string
}) {
  return (
    <table data-testid="model-performance-table" className={cn("w-full table-fixed text-[11px]", className)}>
      <thead>
        <tr className="text-left text-muted-foreground">
          {columns.map((col) => (
            <th
              key={col.key}
              scope="col"
              aria-sort={sortBy === col.key ? (direction === "asc" ? "ascending" : "descending") : "none"}
              className={cn("py-1 font-medium", col.key !== "modelId" && "text-right")}
            >
              <button
                type="button"
                onClick={() => onSort(col.key)}
                className={cn("flex items-center gap-1 whitespace-nowrap hover:text-text-bright", col.key !== "modelId" && "ml-auto")}
              >
                {col.label}
                {sortBy === col.key && <span aria-hidden="true">{direction === "asc" ? "↑" : "↓"}</span>}
              </button>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {groups.map((group) => (
          <tr
            key={`${group.runtimeId}:${group.providerId}:${group.modelId}:${group.kind}`}
            data-testid="model-performance-row"
            tabIndex={onRowClick ? 0 : undefined}
            role={onRowClick ? "button" : undefined}
            onClick={onRowClick ? () => onRowClick(group) : undefined}
            onKeyDown={
              onRowClick
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      onRowClick(group)
                    }
                  }
                : undefined
            }
            className={cn(
              "border-t border-hairline text-text-body",
              onRowClick && "cursor-pointer hover:bg-hover"
            )}
          >
            {columns.map((col) => (
              <td key={col.key} className={cn("py-1.5 tabular-nums", col.key === "modelId" ? "truncate pr-2" : "pl-2 text-right")}>
                {col.format(group)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
