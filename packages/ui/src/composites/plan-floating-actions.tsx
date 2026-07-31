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
  Ellipsis,
  LoaderCircle,
  Play,
  RefreshCw,
  Save,
  Send,
  Zap
} from "lucide-react"
import type { ComponentType } from "react"
import { Button } from "../components/button.js"
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
  readonly onSave?: () => void
  readonly onRetry?: () => void
  readonly onKeepLocal?: () => void
}): Action | null => {
  if (input.transientState !== undefined) {
    return { label: "Composing plan", icon: LoaderCircle, disabled: true }
  }
  if (input.syncState === "error") {
    return { label: "Retry save", icon: RefreshCw, onRun: input.onRetry }
  }
  if (input.syncState === "conflict") {
    return {
      label: "Keep local and save",
      icon: AlertTriangle,
      onRun: input.onKeepLocal
    }
  }
  if (input.syncState === "editing") {
    return { label: "Save now", icon: Save, onRun: input.onSave }
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
  onSave,
  onRetry,
  onKeepLocal,
  onAcceptRemote
}: {
  status?: PlanDocumentStatus
  syncState: PlanEditorSyncState
  transientState?: PlanEditorTransientState
  canApprove?: boolean
  compact?: boolean
  onApprove?: (executionMode?: ExecutionMode) => void
  onResume?: () => void
  onRevise?: () => void
  onSendToAgent?: () => void
  onSave?: () => void
  onRetry?: () => void
  onKeepLocal?: () => void
  onAcceptRemote?: () => void
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
    onSave,
    onRetry,
    onKeepLocal
  })
  if (primary === null) return null

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
      : []),
    ...(syncState === "conflict"
      ? [{ label: "Use remote revision", icon: RefreshCw, onRun: onAcceptRemote }]
      : [])
  ]
  const PrimaryIcon = primary.icon

  return (
    <div
      role="toolbar"
      aria-label={
        status === "proposed" || status === "revising"
          ? "Plan approval options"
          : "Plan actions"
      }
      data-testid="plan-floating-actions"
      className="absolute bottom-4 left-1/2 z-30 flex max-w-[calc(100%-1rem)] -translate-x-1/2 items-center gap-1 rounded-xl border border-line bg-sunken/95 p-1.5 shadow-lg backdrop-blur"
    >
      <Button
        size="sm"
        aria-label={primary.label}
        disabled={primary.disabled}
        onClick={primary.onRun}
        className={cn(compact && "px-2")}
      >
        <PrimaryIcon
          className={cn(
            "size-3.5",
            (status === "executing" || transientState !== undefined) && "animate-spin"
          )}
        />
        {!compact && primary.label}
      </Button>
      {secondary.length > 0 && (
        <DropdownMenuRoot>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="More plan actions"
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-surface hover:text-text-bright focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Ellipsis className="size-4" />
            </button>
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
    </div>
  )
}
