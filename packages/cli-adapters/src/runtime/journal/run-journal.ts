import { Data, Effect, Schema } from "effect"
import type { ToolRisk } from "../tools/tool-registry.js"
import { AtomicJsonFile } from "../persistence/atomic-json-file.js"

export const RunReceiptStatus = Schema.Literal(
  "started",
  "settled",
  "denied",
  "cancelled",
  "failed",
  "uncertain"
)
export type RunReceiptStatus = Schema.Schema.Type<typeof RunReceiptStatus>

export const RunReceipt = Schema.Struct({
  callId: Schema.String,
  runId: Schema.String,
  /** Optional only while journal files from before session association drain. */
  sessionId: Schema.optional(Schema.String),
  chatId: Schema.optional(Schema.String),
  toolId: Schema.String,
  risk: Schema.Literal("read", "network", "mutate", "execute"),
  targetCategory: Schema.NullOr(Schema.String),
  status: RunReceiptStatus,
  startedAt: Schema.String,
  settledAt: Schema.NullOr(Schema.String),
  resultSummary: Schema.NullOr(Schema.String),
  failureCode: Schema.NullOr(Schema.String),
  fileChangeSetIds: Schema.Array(Schema.String),
  safeToRetry: Schema.Boolean
})
export type RunReceipt = Schema.Schema.Type<typeof RunReceipt>

const RunJournalDocument = Schema.Array(RunReceipt)
const decode = (raw: string): ReadonlyArray<RunReceipt> =>
  Schema.decodeUnknownSync(RunJournalDocument)(JSON.parse(raw))

const terminal = (status: RunReceiptStatus): boolean => status !== "started"
const safeRisk = (risk: ToolRisk): boolean => risk === "read" || risk === "network"

export class RunJournalError extends Data.TaggedError("RunJournalError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const journalEffect = <A>(message: string, operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) => new RunJournalError({ message, cause })
  })

export class RunJournal {
  readonly #document: AtomicJsonFile<ReadonlyArray<RunReceipt>>
  readonly #now: () => Date

  constructor(input: { readonly file: string; readonly now?: () => Date }) {
    this.#document = new AtomicJsonFile({ file: input.file, decode, fallback: () => [] })
    this.#now = input.now ?? (() => new Date())
  }

  list(): Effect.Effect<ReadonlyArray<RunReceipt>, RunJournalError> {
    return journalEffect("Failed to read run journal", () =>
      this.#document.read()
    )
  }

  start(input: {
    readonly callId: string
    readonly runId: string
    readonly sessionId: string
    readonly chatId: string
    readonly toolId: string
    readonly risk: ToolRisk
    readonly targetCategory?: string | null
  }): Effect.Effect<void, RunJournalError> {
    const receipt: RunReceipt = {
      ...input,
      targetCategory: input.targetCategory ?? null,
      status: "started",
      startedAt: this.#now().toISOString(),
      settledAt: null,
      resultSummary: null,
      failureCode: null,
      fileChangeSetIds: [],
      safeToRetry: false
    }
    return journalEffect("Failed to start run receipt", () =>
      this.#document.update((current) => {
        if (current.some((item) => item.callId === input.callId))
          throw new Error(`duplicate call id: ${input.callId}`)
        return [...current, receipt]
      })
    )
  }

  settle(input: {
    readonly callId: string
    readonly status: Exclude<RunReceiptStatus, "started" | "uncertain">
    readonly resultSummary?: string | null
    readonly failureCode?: string | null
    readonly fileChangeSetIds?: ReadonlyArray<string>
  }): Effect.Effect<void, RunJournalError> {
    return journalEffect("Failed to settle run receipt", () =>
      this.#document.update((current) =>
        current.map((receipt) => {
          if (receipt.callId !== input.callId) return receipt
          if (terminal(receipt.status))
            throw new Error(`call already settled: ${input.callId}`)
          return {
            ...receipt,
            status: input.status,
            settledAt: this.#now().toISOString(),
            resultSummary: input.resultSummary ?? null,
            failureCode: input.failureCode ?? null,
            fileChangeSetIds: input.fileChangeSetIds ?? [],
            safeToRetry: safeRisk(receipt.risk) && input.status !== "settled"
          }
        })
      )
    )
  }

  reconcileAfterRestart(): Effect.Effect<
    ReadonlyArray<RunReceipt>,
    RunJournalError
  > {
    return journalEffect("Failed to reconcile run journal", async () => {
      await this.#document.update((current) =>
        current.map((receipt) => {
          if (receipt.status !== "started") return receipt
          const safeToRetry = safeRisk(receipt.risk)
          return {
            ...receipt,
            status: safeToRetry ? "failed" : "uncertain",
            settledAt: this.#now().toISOString(),
            failureCode: "process-restarted-before-settle",
            safeToRetry
          }
        })
      )
      return (await this.#document.read()).filter(
        (receipt) => receipt.status === "uncertain"
      )
    })
  }

  /** Record an operator inspection without making the uncertain call retryable. */
  acknowledge(callId: string): Effect.Effect<void, RunJournalError> {
    return journalEffect("Failed to acknowledge run receipt", () =>
      this.#document.update((current) =>
        current.map((receipt) =>
          receipt.callId === callId && receipt.status === "uncertain"
            ? {
                ...receipt,
                status: "failed" as const,
                failureCode: "operator-reviewed-uncertain-mutation",
                safeToRetry: false
              }
            : receipt
        )
      )
    )
  }
}
