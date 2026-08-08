import type { PlanTaskStatus } from "./plan-document.js"

export type PersistedPlanTaskStatus = Exclude<PlanTaskStatus, "pending">

export interface PlanTaskProgressRecord {
  readonly stageId: string
  readonly stageFingerprint: string
  readonly taskId: string
  readonly status: PersistedPlanTaskStatus
}

export type PlanTaskProtocolToken =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "progress"; readonly progress: PlanTaskProgressRecord }

const TASK_MARKER_SOURCE =
  "PLAN_TASK stage=([^\\s]+) fingerprint=([^\\s]+) task=([^\\s]+) status=(in-progress|completed|blocked)"

const markerPattern = (): RegExp => new RegExp(TASK_MARKER_SOURCE, "g")

const recordOf = (match: RegExpExecArray): PlanTaskProgressRecord => ({
  stageId: match[1]!,
  stageFingerprint: match[2]!,
  taskId: match[3]!,
  status: match[4]! as PersistedPlanTaskStatus
})

/** Parse complete checkpoint records even when providers concatenate them. */
export const planTaskProgressRecords = (
  text: string
): ReadonlyArray<PlanTaskProgressRecord> => {
  const pattern = markerPattern()
  const records: Array<PlanTaskProgressRecord> = []
  let match = pattern.exec(text)
  while (match !== null) {
    records.push(recordOf(match))
    match = pattern.exec(text)
  }
  return records
}

/**
 * Split assistant text into visible prose and structured progress records.
 * A trailing partial marker is withheld until the next streamed delta completes
 * it, so fingerprints never flash in the conversation.
 */
export const planTaskProtocolTokens = (
  text: string
): ReadonlyArray<PlanTaskProtocolToken> => {
  const pattern = markerPattern()
  const tokens: Array<PlanTaskProtocolToken> = []
  let cursor = 0
  let match = pattern.exec(text)
  while (match !== null) {
    const before = text.slice(cursor, match.index)
    if (before.length > 0) tokens.push({ kind: "text", text: before })
    tokens.push({ kind: "progress", progress: recordOf(match) })
    cursor = match.index + match[0].length
    match = pattern.exec(text)
  }

  let tail = text.slice(cursor)
  const partialAt = tail.lastIndexOf("PLAN_")
  if (partialAt >= 0) tail = tail.slice(0, partialAt)
  if (tail.length > 0) tokens.push({ kind: "text", text: tail })
  return tokens
}

/** Visible prose with all complete and partial checkpoint machinery removed. */
export const stripPlanTaskProgressProtocol = (text: string): string =>
  planTaskProtocolTokens(text)
    .filter((token): token is Extract<PlanTaskProtocolToken, { kind: "text" }> =>
      token.kind === "text"
    )
    .map((token) => token.text)
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()
