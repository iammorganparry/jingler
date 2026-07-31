import type { StreamEvent } from "@jingler/core"
import { isBackgroundTaskEvent, isSubagentEvent } from "@jingler/core"

/**
 * Where a stream event goes.
 *
 * Every event a harness emits reaches the renderer, but only some belong in the
 * persisted transcript, and getting that wrong is expensive in ways that are not
 * obvious at the call site:
 *
 *  - A **background-task** event describes work that outlives this turn, so it
 *    folds into the session's task registry. Persisting it onto the assistant
 *    message would pin a still-running task to a finished turn.
 *  - A **sub-agent** event drives its own live-only tab. Folded into the main
 *    turn it would interleave an unrelated agent's output into the transcript.
 *  - **`ToolDelta`** is live tool output, and the trap: it is NOT a sub-agent
 *    event, so before it was routed explicitly it fell through to the transcript
 *    fold — a full read + decode + encode + rewrite of the transcript file on
 *    every tick of a running command. `ToolEnd` persists the authoritative output.
 *
 * Stated as a total function so the rule can be read in one place and enumerated
 * in a test, rather than inferred from the order of four early returns.
 */
export type EventRoute =
  /** Into the session's background-task registry, and on to the renderer. */
  | "background-task"
  /** To the renderer's per-sub-agent transcript only. */
  | "subagent"
  /** To the renderer only — never written to disk. */
  | "stream-only"
  /** Folded into the assistant turn and persisted. */
  | "transcript"

/**
 * Route one event. Order matters: a background-task event can also look like a
 * sub-agent event (a backgrounded `Task` is both), and the registry has to win —
 * it is the surface that survives the turn.
 */
export const routeOf = (event: StreamEvent): EventRoute => {
  if (isBackgroundTaskEvent(event)) return "background-task"
  if (isSubagentEvent(event)) return "subagent"
  if (event._tag === "ToolDelta" || event._tag === "PlanDraft") {
    return "stream-only"
  }
  return "transcript"
}

/** Whether this event ends the turn. The first one wins; later ones are ignored. */
export const isTerminal = (event: StreamEvent): boolean =>
  event._tag === "Done" || event._tag === "Failed"
