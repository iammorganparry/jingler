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
  Cloud,
  Ellipsis,
  LoaderCircle,
  Play,
  RefreshCw,
  Save,
  Send,
  WifiOff,
  Zap
} from "lucide-react"
import type { ComponentType } from "react"
import { Button } from "../components/button.js"
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

const SYNC: Record<
  PlanEditorSyncState,
  { readonly label: string; readonly className: string; readonly icon: typeof Cloud }
> = {
  loading: { label: "Loading", className: "text-muted-foreground", icon: RefreshCw },
  clean: { label: "Synced", className: "text-green", icon: Check },
  editing: { label: "Editing", className: "text-yellow", icon: Cloud },
  saving: { label: "Saving", className: "text-blue", icon: RefreshCw },
  conflict: { label: "Conflict", className: "text-red", icon: AlertTriangle },
  error: { label: "Save failed", className: "text-red", icon: WifiOff }
}

const transientSync = (state: PlanEditorTransientState) => ({
  label:
    state === "composing"
      ? "Composing"
      : state === "validating"
        ? "Validating"
        : "Loading revision",
  className: "text-blue",
  icon: RefreshCw
})

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
  revision,
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
  revision?: number
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
  const sync = transientState === undefined ? SYNC[syncState] : transientSync(transientState)
  const SyncIcon = sync.icon

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
            pulse={
              transientState === "composing" ||
              transientState === "validating" ||
              status === "executing"
            }
          >
            {transientState ?? status?.replace("-", " ")}
          </Pill>
        )}
        {revision !== undefined && transientState === undefined && !compact && (
          <span className="whitespace-nowrap font-mono text-[10px] text-muted-foreground">
            revision {revision}
          </span>
        )}
        <span
          role="status"
          aria-live="polite"
          className={cn(
            "flex items-center gap-1.5 whitespace-nowrap text-[10.5px] font-medium",
            sync.className
          )}
        >
          <SyncIcon
            className={cn(
              "size-3.5",
              (transientState !== undefined || syncState === "saving") && "animate-spin"
            )}
          />
          {sync.label}
        </span>
      </div>
      {primary !== null && (
        <>
          <span aria-hidden="true" className="h-5 w-px flex-none bg-line" />
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
        </>
      )}
      {primary !== null && secondary.length > 0 && (
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
