import type { PlanAnnotation as PlanAnnotationModel } from "@jingler/core"
import { MessageSquareText } from "lucide-react"

export function PlanAnnotation({ annotation }: { annotation: PlanAnnotationModel }) {
  return (
    <aside className="rounded-lg border border-purple/30 bg-purple/5 p-3">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-purple">
        <MessageSquareText className="size-3.5" />
        {annotation.author} annotation · {annotation.status}
      </div>
      <p className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-text-body">
        {annotation.body}
      </p>
    </aside>
  )
}
