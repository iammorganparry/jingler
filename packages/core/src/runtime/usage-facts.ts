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
