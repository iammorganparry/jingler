import type { PlanAcceptance as PlanAcceptanceModel, PlanAcceptanceStatus } from "@jingler/core"
import { CheckCircle2, Circle, CircleSlash2, XCircle } from "lucide-react"
import { useState } from "react"
import { cn } from "../lib/cn.js"

const STATUS: Record<
  PlanAcceptanceStatus,
  { readonly label: string; readonly className: string; readonly icon: typeof Circle }
> = {
  pending: { label: "Pending", className: "text-muted-foreground", icon: Circle },
  passed: { label: "Passed", className: "text-green", icon: CheckCircle2 },
  failed: { label: "Failed", className: "text-red", icon: XCircle },
  waived: { label: "Waived", className: "text-yellow", icon: CircleSlash2 }
}

export function PlanAcceptance({
  criterion,
  disabled = false,
  onChange
}: {
  criterion: PlanAcceptanceModel
  disabled?: boolean
  onChange?: (status: PlanAcceptanceStatus, evidence: string | null) => void
}) {
  const [evidence, setEvidence] = useState(criterion.evidence ?? "")
  const meta = STATUS[criterion.status]
  const Icon = meta.icon

  return (
    <div className="rounded-lg border border-line bg-sunken p-3">
      <div className="flex items-start gap-2.5">
        <Icon className={cn("mt-0.5 size-4 flex-none", meta.className)} />
        <div className="min-w-0 flex-1">
          <p className="text-[12px] leading-relaxed text-text-body">{criterion.text}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor={`criterion-${criterion.id}`}>
              Status for {criterion.text}
            </label>
            <select
              id={`criterion-${criterion.id}`}
              aria-label={`Acceptance status: ${criterion.text}`}
              value={criterion.status}
              disabled={disabled}
              onChange={(event) =>
                onChange?.(
                  event.target.value as PlanAcceptanceStatus,
                  evidence.trim().length > 0 ? evidence : null
                )
              }
              className="rounded-md border border-line bg-editor px-2 py-1 text-[11px] text-text outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {Object.entries(STATUS).map(([value, item]) => (
                <option key={value} value={value}>{item.label}</option>
              ))}
            </select>
            <input
              aria-label={`Evidence for ${criterion.text}`}
              value={evidence}
              disabled={disabled}
              placeholder="Evidence or waiver reason"
              onChange={(event) => setEvidence(event.target.value)}
              onBlur={() => {
                if (evidence !== (criterion.evidence ?? "")) {
                  onChange?.(criterion.status, evidence.trim().length > 0 ? evidence : null)
                }
              }}
              className="min-w-[220px] flex-1 rounded-md border border-line bg-editor px-2 py-1 text-[11px] text-text outline-none placeholder:text-dim focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        </div>
      </div>
    </div>
  )
}
