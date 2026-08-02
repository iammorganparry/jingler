import type { ExecutionMode, PlanDocumentStatus } from "@jingler/core"
import {
  Content as DropdownMenuContent,
  Item as DropdownMenuItem,
  Portal as DropdownMenuPortal,
  Root as DropdownMenuRoot,
  Trigger as DropdownMenuTrigger
} from "@radix-ui/react-dropdown-menu"
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  LoaderCircle,
  Play,
  RefreshCw,
  Save,
  Send,
  Zap
} from "lucide-react"
import type { ComponentType } from "react"
import { Button } from "../components/button.js"
import { ButtonGroup } from "../components/button-group.js"
import { Pill } from "../components/pill.js"
import { cn } from "../lib/cn.js"
import type {
  PlanEditorSyncState,
  PlanEditorTransientState
} from "./plan-editor.js"

interface Action {
  readonly label: string
  readonly icon: ComponentType<{ className?: string }>
  readonly onRun?: () => void
  readonly disabled?: boolean
}

const primaryAction = (input: {
  readonly status?: PlanDocumentStatus
  readonly syncState: PlanEditorSyncState
  readonly transientState?: PlanEditorTransientState
  readonly canApprove: boolean
  readonly onApprove?: (executionMode?: ExecutionMode) => void
  readonly onResume?: () => void
  readonly onRevise?: () => void
  readonly onSendToAgent?: () => void
  readonly onRetry?: () => void
}): Action | null => {
  if (input.transientState !== undefined) {
    const transientLabel: Record<PlanEditorTransientState, string> = {
      composing: "Composing plan",
      validating: "Validating plan",
      promoting: "Loading revision"
    }
    return {
      label: transientLabel[input.transientState],
      icon: LoaderCircle,
      disabled: true
    }
  }
  // The plan is agent-authored and read-only; the only sync state that still
  // reaches the operator is a load failure, which offers a reload.
  if (input.syncState === "error") {
    return { label: "Retry", icon: RefreshCw, onRun: input.onRetry }
  }

  switch (input.status) {
    case "draft":
      return { label: "Send to agent", icon: Send, onRun: input.onSendToAgent }
    case "proposed":
    case "revising":
      return {
        label: "Approve",
        icon: Check,
        disabled: !input.canApprove,
        onRun: () => input.onApprove?.()
      }
    case "stale":
      return {
        label: "Approve & implement",
        icon: Play,
        disabled: !input.canApprove,
        onRun: input.onResume
      }
    case "approved":
    case "executing":
      return { label: "Implementation running", icon: LoaderCircle, disabled: true }
    case "needs-verification":
      return { label: "Ready for verification", icon: CheckCircle2, disabled: true }
    case "done":
      return { label: "Plan completed", icon: CheckCircle2, disabled: true }
    case "rejected":
      return { label: "Revise plan", icon: Send, onRun: input.onRevise }
    default:
      return null
  }
}

export function PlanFloatingActions({
  status,
  syncState,
  transientState,
  canApprove = true,
  compact = false,
  onApprove,
  onResume,
  onRevise,
  onSendToAgent,
  onRetry
}: {
  status?: PlanDocumentStatus
  /** Accepted for compatibility; the read-only bar no longer displays it. */
  revision?: number
  syncState: PlanEditorSyncState
  transientState?: PlanEditorTransientState
  canApprove?: boolean
  compact?: boolean
  onApprove?: (executionMode?: ExecutionMode) => void
  onResume?: () => void
  onRevise?: () => void
  onSendToAgent?: () => void
  onRetry?: () => void
}) {
  const primary = primaryAction({
    status,
    syncState,
    transientState,
    canApprove,
    onApprove,
    onResume,
    onRevise,
    onSendToAgent,
    onRetry
  })

  const secondary: ReadonlyArray<Action> = [
    ...(status === "proposed" || status === "revising"
      ? [
          {
            label: "Approve and auto",
            icon: Zap,
            disabled: !canApprove,
            onRun: () => onApprove?.("auto")
          },
          { label: "Revise with agent", icon: Send, onRun: onRevise }
        ]
      : []),
    ...(status === "stale"
      ? [{ label: "Revise with agent", icon: Send, onRun: onRevise }]
      : [])
  ]
  const PrimaryIcon = primary?.icon

  return (
    <div
      role="toolbar"
      aria-label={
        status === "proposed" || status === "revising"
          ? "Plan approval options"
          : "Plan actions"
      }
      data-testid="plan-floating-actions"
      className="absolute bottom-4 left-1/2 z-30 flex max-w-[calc(100%-1rem)] -translate-x-1/2 items-center gap-1.5 rounded-xl border border-line bg-sunken/95 p-1.5 shadow-lg backdrop-blur"
    >
      <div
        data-testid="plan-status-summary"
        className="pointer-events-none flex min-w-0 items-center gap-2 px-1"
      >
        {(status !== undefined || transientState !== undefined) && (
          <Pill
            tone={
              transientState !== undefined
                ? "blue"
                : status === "done" || status === "approved"
                  ? "green"
                  : status === "needs-verification"
                    ? "yellow"
                    : "blue"
            }
            pulse={status === "executing"}
          >
            {transientState ?? status?.replace("-", " ")}
          </Pill>
        )}
      </div>
      {primary !== null && (
        <>
          <span aria-hidden="true" className="h-5 w-px flex-none bg-line" />
          <ButtonGroup>
            <Button
              size="sm"
              aria-label={primary.label}
              disabled={primary.disabled}
              onClick={primary.onRun}
              className={cn(compact && "px-2")}
            >
              {PrimaryIcon !== undefined && (
                <PrimaryIcon
                  className={cn(
                    "size-3.5",
                    (status === "executing" || transientState !== undefined) && "animate-spin"
                  )}
                />
              )}
              {!compact && primary.label}
            </Button>
            {secondary.length > 0 && (
              <DropdownMenuRoot>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    aria-label="More plan actions"
                    className="px-2 shadow-[inset_1px_0_0_var(--sb-brand-hover)]"
                  >
                    <ChevronDown className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuContent
                    side="top"
                    align="end"
                    sideOffset={8}
                    collisionPadding={8}
                    className="z-50 min-w-48 rounded-lg border border-line bg-sunken p-1.5 shadow-lg"
                  >
                    {secondary.map((action) => {
                      const Icon = action.icon
                      return (
                        <DropdownMenuItem
                          key={action.label}
                          disabled={action.disabled}
                          onSelect={action.onRun}
                          className="flex cursor-default items-center gap-2 rounded-md px-2.5 py-2 text-[11px] text-text-body outline-none data-[disabled]:opacity-45 data-[highlighted]:bg-surface data-[highlighted]:text-text-bright"
                        >
                          <Icon className="size-3.5" />
                          {action.label}
                        </DropdownMenuItem>
                      )
                    })}
                  </DropdownMenuContent>
                </DropdownMenuPortal>
              </DropdownMenuRoot>
            )}
          </ButtonGroup>
        </>
      )}
    </div>
  )
}
