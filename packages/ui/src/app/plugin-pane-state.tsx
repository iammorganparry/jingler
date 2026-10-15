import { PanelRight, TriangleAlert } from "lucide-react"
import { Button } from "../components/button.js"
import { EmptyState, ListSkeleton } from "../components/feedback.js"

export interface PluginPaneStateProps {
  /** `loading` skeleton, `empty` (pane rendered nothing) or `error` (pane crashed). */
  readonly variant: "loading" | "empty" | "error"
  readonly pluginId: string
  /** The crash message, shown in mono under the title. `error` only. */
  readonly message?: string
  /** Re-mounts the pane. `error` only. */
  readonly onRetry?: () => void
}

/** The loading, empty and crashed states of a plugin's dock pane, on the shared feedback patterns. */
export function PluginPaneState({ variant, pluginId, message, onRetry }: PluginPaneStateProps) {
  if (variant === "loading") {
    return (
      <div data-testid={`plugin-pane-loading-${pluginId}`} className="w-[220px] p-3">
        <ListSkeleton rows={4} rowHeight={20} gap={8} />
      </div>
    )
  }
  if (variant === "empty") {
    return (
      <div data-testid={`plugin-pane-empty-${pluginId}`} className="flex min-w-[220px] items-center justify-center">
        <EmptyState
          icon={<PanelRight size={22} strokeWidth={1.5} />}
          title="Nothing to show yet"
          description={`“${pluginId}” has no content for this pane.`}
        />
      </div>
    )
  }
  return (
    <div
      role="alert"
      data-testid={`plugin-pane-error-${pluginId}`}
      className="flex min-h-0 min-w-0 flex-col justify-center bg-panel"
    >
      <EmptyState
        icon={<TriangleAlert size={22} strokeWidth={1.5} className="text-state-failed" />}
        title={`“${pluginId}” pane stopped working`}
        description={
          <>
            <span className="block break-words font-mono text-[10.5px] leading-[1.5]">{message}</span>
            <span className="mt-1 block">The rest of the app is unaffected. Disable this plugin in Settings › Plugins.</span>
          </>
        }
        action={
          <Button
            variant="secondary"
            size="sm"
            data-testid={`plugin-pane-error-retry-${pluginId}`}
            onClick={onRetry}
          >
            Retry
          </Button>
        }
      />
    </div>
  )
}
