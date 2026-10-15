import { Button } from "../components/button.js"
import { PierreAnnotationRegion, type PierreAgentEditAnnotation } from "./pierre-annotations.js"

/** Read-only `Agent edit · Turn N` marker under an edited range; clicking it jumps the timeline to that turn. */
export function AgentEditLabel({
  payload,
  onSelect
}: {
  readonly payload: PierreAgentEditAnnotation
  readonly onSelect: ((turnId: string) => void) | undefined
}) {
  return (
    <PierreAnnotationRegion
      label={`${payload.label} on ${payload.path}`}
      payload={payload}
      className="flex items-center px-3 py-0.5"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-5 px-1.5 font-mono text-[11px]"
        onClick={() => onSelect?.(payload.turnId)}
      >
        {payload.label}
      </Button>
    </PierreAnnotationRegion>
  )
}
