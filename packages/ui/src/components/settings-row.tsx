import type { ReactNode } from "react"
import { cn } from "../lib/cn.js"

/** Label + help on the left, control on the right. Long help wraps; the control never does. */
export function SettingsRow({
  label,
  help,
  control,
  className
}: {
  label: ReactNode
  help?: ReactNode
  control: ReactNode
  className?: string
}) {
  return (
    <div data-testid="settings-row" className={cn("flex items-start gap-4 px-4 py-3", className)}>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-text-bright">{label}</div>
        {help && <div className="mt-0.5 text-[12px] leading-[1.5] text-muted-foreground">{help}</div>}
      </div>
      <div data-testid="settings-row-control" className="flex flex-none items-center">{control}</div>
    </div>
  )
}

/** A bordered group of SettingsRows (r12, hairline between rows) with an optional header. */
export function SettingsCard({ title, children, className }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("flex flex-col gap-2", className)}>
      {title && <h3 className="px-1 text-[12px] font-medium text-muted-foreground">{title}</h3>}
      <div className="divide-y divide-line overflow-hidden rounded-xl border border-line">{children}</div>
    </section>
  )
}
