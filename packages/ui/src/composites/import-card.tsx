import type { ImportCardState } from "./import-card-model.js"
import { Button } from "../components/button.js"
import { Card } from "../components/card.js"
import { Spin } from "../components/spin.js"
import { StatusRow } from "../components/status-row.js"

/** Home › offer to import MCP servers found in other agents. Dismissed = not rendered. */
export function ImportCard({
  state,
  onReview,
  onRetry,
  onDismiss
}: {
  readonly state: ImportCardState
  readonly onReview: () => void
  readonly onRetry: () => void
  readonly onDismiss: () => void
}) {
  return (
    <Card className="px-4 py-3" data-testid="import-card">
      <div className="text-[11px] text-dim">MCP servers</div>
      {state.kind === "detecting" ? (
        <StatusRow icon={<Spin animation="spin"><span className="size-3 rounded-full border-2 border-line border-t-transparent" /></Spin>} className="mt-1">Looking for MCP servers in Claude, Codex and OpenCode…</StatusRow>
      ) : (
        <>
          <p className="mt-1 text-[13px] text-text-bright">
            {state.kind === "found"
              ? `Found ${state.count} server${state.count === 1 ? "" : "s"} you can import`
              : state.message}
          </p>
          <div className="mt-2 flex items-center gap-2">
            {state.kind === "found" ? (
              <Button size="sm" onClick={onReview}>Review</Button>
            ) : (
              <Button size="sm" onClick={onRetry}>Retry</Button>
            )}
            <Button size="sm" variant="secondary" onClick={onDismiss}>Not now</Button>
          </div>
        </>
      )}
    </Card>
  )
}
