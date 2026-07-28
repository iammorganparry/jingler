import type { ExecutionMode } from "@jingler/core"
import { Check, Zap } from "lucide-react"
import { Button } from "../components/button.js"
import { ButtonGroup } from "../components/button-group.js"

export function PlanApprovalActions({
  onApprove,
  className,
  disabled = false
}: {
  onApprove?: (executionMode?: ExecutionMode) => void
  className?: string
  disabled?: boolean
}) {
  return (
    <ButtonGroup aria-label="Plan approval options" className={className}>
      <Button size="sm" disabled={disabled} onClick={() => onApprove?.()}>
        <Check className="size-3" />
        Approve
      </Button>
      <Button variant="secondary" size="sm" disabled={disabled} onClick={() => onApprove?.("auto")}>
        <Zap className="size-3 text-yellow" />
        Approve and auto
      </Button>
    </ButtonGroup>
  )
}
