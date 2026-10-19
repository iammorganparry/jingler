import { Schema } from "effect"
import { AgentRuntimeId } from "./agent-endpoint.js"

/** One terminal, idempotent accounting fact for a parent turn or delegated child. */
export const UsageFact = Schema.Struct({
  id: Schema.String,
  runId: Schema.String,
  sessionId: Schema.String,
  chatId: Schema.String,
  parentRunId: Schema.NullOr(Schema.String),
  runtimeId: AgentRuntimeId,
  providerId: Schema.NullOr(Schema.String),
  modelId: Schema.String,
  kind: Schema.Literal("parent", "child"),
  startedAt: Schema.String,
  endedAt: Schema.String,
  durationMs: Schema.Number,
  inputTokens: Schema.NullOr(Schema.Number),
  outputTokens: Schema.NullOr(Schema.Number),
  cacheReadTokens: Schema.NullOr(Schema.Number),
  cacheWriteTokens: Schema.NullOr(Schema.Number),
  reasoningTokens: Schema.NullOr(Schema.Number),
  totalTokens: Schema.NullOr(Schema.Number),
  costUsd: Schema.NullOr(Schema.Number),
  toolCalls: Schema.NullOr(Schema.Number),
  outcome: Schema.Literal("success", "error", "cancelled", "unknown"),
  provenance: Schema.String
})
export type UsageFact = Schema.Schema.Type<typeof UsageFact>

type UsageFactCounters = Pick<
  UsageFact,
  | "inputTokens"
  | "outputTokens"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "reasoningTokens"
  | "totalTokens"
  | "costUsd"
  | "toolCalls"
>
type UsageFactInput = Omit<
  UsageFact,
  keyof UsageFactCounters | "startedAt" | "endedAt" | "durationMs"
> & Partial<UsageFactCounters> & {
  readonly startedAt: number
  readonly endedAt?: number
  readonly durationMs?: number
}

export const makeUsageFact = (input: UsageFactInput): UsageFact => {
  const endedAt = input.endedAt ?? Date.now()
  return {
    ...input,
    startedAt: new Date(input.startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: input.durationMs ?? Math.max(0, endedAt - input.startedAt),
    inputTokens: input.inputTokens ?? null,
    outputTokens: input.outputTokens ?? null,
    cacheReadTokens: input.cacheReadTokens ?? null,
    cacheWriteTokens: input.cacheWriteTokens ?? null,
    reasoningTokens: input.reasoningTokens ?? null,
    totalTokens: input.totalTokens ?? null,
    costUsd: input.costUsd ?? null,
    toolCalls: input.toolCalls ?? null
  }
}

export const UsageReportGroup = Schema.Struct({
  runtimeId: AgentRuntimeId,
  providerId: Schema.NullOr(Schema.String),
  modelId: Schema.String,
  kind: Schema.Literal("parent", "child"),
  runCount: Schema.Number,
  successRate: Schema.NullOr(Schema.Number),
  durationMs: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  cacheWriteTokens: Schema.Number,
  reasoningTokens: Schema.Number,
  totalTokens: Schema.Number,
  toolCalls: Schema.Number,
  knownCostUsd: Schema.Number,
  costCoverage: Schema.Number
})
export type UsageReportGroup = Schema.Schema.Type<typeof UsageReportGroup>

export const UsageReport = Schema.Struct({
  generatedAt: Schema.String,
  facts: Schema.Array(UsageFact),
  groups: Schema.Array(UsageReportGroup)
})
export type UsageReport = Schema.Schema.Type<typeof UsageReport>

const groupKey = (fact: UsageFact): string => JSON.stringify([
  fact.runtimeId,
  fact.providerId,
  fact.modelId,
  fact.kind
])

/** Aggregate facts without treating unknown token/cost values as zero spend. */
type MutableGroup = {
  -readonly [Key in keyof Omit<UsageReportGroup, "successRate" | "costCoverage">]: UsageReportGroup[Key]
} & {
  costFacts: number
  successCount: number
}

export const usageReportFromFacts = (
  facts: ReadonlyArray<UsageFact>,
  generatedAt = new Date().toISOString()
): UsageReport => {
  const grouped = new Map<string, MutableGroup>()
  for (const fact of facts) {
    const key = groupKey(fact)
    const current = grouped.get(key) ?? {
      runtimeId: fact.runtimeId,
      providerId: fact.providerId,
      modelId: fact.modelId,
      kind: fact.kind,
      runCount: 0,
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      toolCalls: 0,
      knownCostUsd: 0,
      costFacts: 0,
      successCount: 0
    }
    current.runCount += 1
    if (fact.outcome === "success") current.successCount += 1
    current.durationMs += fact.durationMs
    current.inputTokens += fact.inputTokens ?? 0
    current.outputTokens += fact.outputTokens ?? 0
    current.cacheReadTokens += fact.cacheReadTokens ?? 0
    current.cacheWriteTokens += fact.cacheWriteTokens ?? 0
    current.reasoningTokens += fact.reasoningTokens ?? 0
    current.totalTokens += fact.totalTokens ?? 0
    current.toolCalls += fact.toolCalls ?? 0
    if (fact.costUsd !== null) {
      current.knownCostUsd += fact.costUsd
      current.costFacts += 1
    }
    grouped.set(key, current)
  }
  const groups = [...grouped.values()].map(({ costFacts, successCount, ...group }) => ({
    ...group,
    successRate: group.runCount === 0 ? null : successCount / group.runCount,
    costCoverage: group.runCount === 0 ? 0 : costFacts / group.runCount
  }))
  return { generatedAt, facts: [...facts], groups }
}

/** Usage view filters: an inclusive ISO `startedAt` range and/or a single runtime. `project` is reserved until facts carry a project id. */
export type UsageFactFilter = {
  readonly from?: string
  readonly to?: string
  readonly runtimeId?: AgentRuntimeId
}

export const filterUsageFacts = (
  facts: ReadonlyArray<UsageFact>,
  filter: UsageFactFilter
): ReadonlyArray<UsageFact> =>
  facts.filter((fact) =>
    (!filter.runtimeId || fact.runtimeId === filter.runtimeId) &&
    (!filter.from || fact.startedAt >= filter.from) &&
    (!filter.to || fact.startedAt <= filter.to)
  )

export const ModelPerformanceSortKey = Schema.Literal(
  "modelId",
  "runCount",
  "successRate",
  "durationMs",
  "totalTokens",
  "knownCostUsd"
)
export type ModelPerformanceSortKey = Schema.Schema.Type<typeof ModelPerformanceSortKey>

/** Per-model report rows sorted by any numeric/string column; `null` sorts before every known value. */
export const sortModelPerformance = (
  groups: ReadonlyArray<UsageReportGroup>,
  sortBy: ModelPerformanceSortKey,
  direction: "asc" | "desc" = "desc"
): ReadonlyArray<UsageReportGroup> => {
  const sorted = [...groups].sort((a, b) => {
    const av = a[sortBy]
    const bv = b[sortBy]
    if (av === bv) return 0
    if (av === null) return -1
    if (bv === null) return 1
    return av < bv ? -1 : 1
  })
  return direction === "asc" ? sorted : sorted.reverse()
}

/** The longest runs, each mapped to the parent turn it belongs to (a child maps to its parent run). */
export const slowestRuns = (
  facts: ReadonlyArray<UsageFact>,
  limit = 5
): ReadonlyArray<UsageFact & { readonly turnRunId: string }> =>
  [...facts]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, limit)
    .map((fact) => ({ ...fact, turnRunId: fact.parentRunId ?? fact.runId }))

/** One point of a per-model duration/token trend, in run order (oldest first). */
export type ModelDetailPoint = {
  readonly runId: string
  readonly startedAt: string
  readonly durationMs: number
  readonly tokens: number
}

/** The group row, a chronological sparkline series and the slowest runs for one model row. */
export type ModelDetail = {
  readonly group: UsageReportGroup
  readonly sparkline: ReadonlyArray<ModelDetailPoint>
  readonly slowestRuns: ReadonlyArray<UsageFact & { readonly turnRunId: string }>
}

/**
 * Drill-down for one `UsageReportGroup` row (same runtime/provider/model/kind key):
 * its aggregate stats, a duration/token trend and the slowest runs within it.
 * `null` when no facts match the selector (the group no longer exists in the current filter).
 */
export const modelDetailFromFacts = (
  facts: ReadonlyArray<UsageFact>,
  selector: Pick<UsageFact, "runtimeId" | "providerId" | "modelId" | "kind">,
  limit = 5
): ModelDetail | null => {
  const matching = facts.filter(
    (fact) =>
      fact.runtimeId === selector.runtimeId &&
      fact.providerId === selector.providerId &&
      fact.modelId === selector.modelId &&
      fact.kind === selector.kind
  )
  const group = usageReportFromFacts(matching).groups[0]
  if (!group) return null
  const sparkline = [...matching]
    .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0))
    .map((fact) => ({ runId: fact.runId, startedAt: fact.startedAt, durationMs: fact.durationMs, tokens: fact.totalTokens ?? 0 }))
  return { group, sparkline, slowestRuns: slowestRuns(matching, limit) }
}
