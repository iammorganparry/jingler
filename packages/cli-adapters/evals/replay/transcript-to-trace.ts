import {
  CURRENT_RUNTIME_CONTRACTS,
  planTaskProgressRecords,
  type Message
} from "@jingler/core"
import type { EvalObservation, EvalTrace } from "../behavior-contract.js"

/**
 * Convert a recorded transcript (`~/jingler/transcripts/<chatId>.json`, an
 * array of `Message`) into a replayable `EvalTrace`, so any real session —
 * including the one that surfaced a regression — becomes a permanent eval
 * fixture for `run-eval.ts replay` and the vitest replay guard.
 *
 * What a transcript can witness, honestly:
 * - `plan-task-status` here means CLAIMED checkpoints — `PlanTaskProgress`
 *   parts (markers the harness folded at settle) plus any raw `PLAN_TASK`
 *   lines surviving in text. A transcript cannot see `PlanStore`, so this is
 *   the claim's upper bound: when even the claim is absent, persistence
 *   certainly never happened — which is exactly the regression signal.
 * - Tool calls carry only the tool NAME (`risk: "unrecorded"`); no arguments,
 *   targets, prose, or file contents enter the trace, so a converted fixture
 *   is sanitized by construction and safe to check in.
 * - Terminals are synthetic: one `Started`/`Done` pair frames the whole
 *   transcript, because scoring requires exactly one settled terminal and a
 *   recorded chat is by definition settled.
 */
export const transcriptToTrace = (
  messages: ReadonlyArray<Message>,
  scenarioId: string
): EvalTrace => {
  const observations: Array<EvalObservation> = [{ kind: "event", tag: "Started" }]
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const part of message.parts) {
      switch (part._tag) {
        case "Tool":
          observations.push({
            kind: "tool-call",
            tool: part.tool.name,
            risk: "unrecorded"
          })
          break
        case "Plan":
          observations.push({ kind: "event", tag: "PlanProposed" })
          break
        case "PlanTaskProgress":
          observations.push({
            kind: "plan-task-status",
            stageId: part.stageId,
            taskId: part.taskId,
            status: part.status
          })
          break
        case "Text":
          for (const record of planTaskProgressRecords(part.text)) {
            observations.push({
              kind: "plan-task-status",
              stageId: record.stageId,
              taskId: record.taskId,
              status: record.status
            })
          }
          break
        default:
          break
      }
    }
  }
  observations.push({ kind: "event", tag: "Done" })
  return {
    scenarioId,
    observations,
    // Synthetic: wall-clock did not survive into the transcript, and replay
    // scoring must never fail a recorded session on timeout.
    durationMs: 1,
    tokens: 0,
    costUsd: 0,
    versions: CURRENT_RUNTIME_CONTRACTS
  }
}
