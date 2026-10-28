import { ChevronRight } from "lucide-react"
import type { ReactNode } from "react"
import { cn } from "../lib/cn.js"

/** Mono 11px path trail under an editor tab strip; `children` sit right-aligned (e.g. the agent-edit marker). */
export function Breadcrumb({
  crumbs,
  children,
  className
}: {
  readonly crumbs: ReadonlyArray<string>
  readonly children?: ReactNode
  readonly className?: string
}) {
  return (
    <nav
      aria-label="Breadcrumb"
      className={cn("flex h-6 flex-none items-center gap-1 px-3 font-mono text-[11px] text-dim", className)}
    >
      {crumbs.map((crumb, index) => (
        <span key={`${index}-${crumb}`} className="flex min-w-0 items-center gap-1">
          {index > 0 && <ChevronRight className="size-3 flex-none" />}
          <span className={cn("truncate", index === crumbs.length - 1 && "text-muted-foreground")}>{crumb}</span>
        </span>
      ))}
      {children === undefined || children === null ? null : <span className="ml-auto flex flex-none items-center gap-2">{children}</span>}
    </nav>
  )
}

/** `● 2 agent edits` — nothing at zero. */
export function AgentEditsMarker({ count }: { readonly count: number }) {
  if (count <= 0) return null
  return (
    <span className="whitespace-nowrap text-text-bright">
      <span aria-hidden className="text-blue">●</span> {count} agent {count === 1 ? "edit" : "edits"}
    </span>
  )
}
