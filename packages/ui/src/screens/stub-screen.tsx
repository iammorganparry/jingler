import { Hammer } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import {
  BUILTIN_TAB_META,
  type BuiltinTabKey
} from "../app/tab-contributions.js"

/**
 * Placeholder for screens not built in this milestone.
 *
 * It used to own a second `META` map keyed by tab, which meant a tab was
 * described in two places — the tab bar's label and this blurb — and adding one
 * meant remembering both. The description now lives with the tab's other
 * presentation in `BUILTIN_TAB_META`, and this component just draws whatever it
 * is handed. That is also what lets a plugin reuse it: an unbuilt plugin tab can
 * render a stub without registering itself in a map inside this package.
 */
export function StubScreen({
  title,
  blurb,
  icon
}: {
  title?: string
  blurb?: string
  icon?: LucideIcon
}) {
  const Icon = icon ?? Hammer
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3.5 bg-editor text-dim">
      <Icon size={40} className="text-line" strokeWidth={1.5} />
      <div className="text-[16px] font-semibold text-text">
        {title ?? "Coming soon"}
      </div>
      <div className="max-w-[360px] text-center text-[13px] leading-[1.6]">
        {blurb}
      </div>
      <div className="font-mono text-[11px] text-line">Next milestone</div>
    </div>
  )
}

/** The stub for a built-in tab, described from the one shared meta table. */
export function BuiltinStubScreen({ tab }: { tab: BuiltinTabKey }) {
  const meta = BUILTIN_TAB_META[tab]
  return <StubScreen title={meta.label} blurb={meta.blurb} icon={meta.icon} />
}
