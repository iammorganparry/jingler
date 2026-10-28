import type { ProviderId } from "@jingler/core"
import { Pill } from "../components/pill.js"
import { ProviderIcon } from "../components/provider-icon.js"

export type HarnessStatus = "ready" | "signing-in" | "needs-attention" | "signed-out"

const STATUS: Record<HarnessStatus, { label: string; tone: "green" | "blue" | "yellow" | "red" }> = {
  ready: { label: "Ready", tone: "green" },
  "signing-in": { label: "Signing in…", tone: "blue" },
  "needs-attention": { label: "Needs attention", tone: "yellow" },
  "signed-out": { label: "Signed out", tone: "red" }
}

/** One agent harness: real provider logo, name, detail line and a one-line status pill. */
export function HarnessCard({
  providerId,
  name,
  detail,
  status
}: {
  readonly providerId: ProviderId
  readonly name: string
  readonly detail?: string
  readonly status: HarnessStatus
}) {
  const { label, tone } = STATUS[status]
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line bg-hover px-3 py-2.5">
      <span className="flex size-8 items-center justify-center rounded-md border border-line bg-canvas">
        <ProviderIcon providerId={providerId} size={17} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium text-text-bright">{name}</div>
        {detail && <div className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground">{detail}</div>}
      </div>
      <Pill tone={tone} pulse={status === "signing-in"}>{label}</Pill>
    </div>
  )
}
