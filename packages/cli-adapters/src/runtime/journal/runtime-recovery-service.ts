import { join } from "node:path"
import { RuntimeRecoveryError, type UncertainMutationRecovery } from "@jingler/core"
import { FileSystem } from "@effect/platform"
import { Effect } from "effect"
import { AppPaths } from "../../app-paths.js"
import { SessionStore } from "../../sessions.js"
import { RunJournal, type RunReceipt } from "./run-journal.js"

const recoveryOf = (receipt: RunReceipt): UncertainMutationRecovery | null =>
  receipt.sessionId === undefined || receipt.chatId === undefined
    ? null
    : {
        runId: receipt.runId,
        callId: receipt.callId,
        chatId: receipt.chatId,
        toolId: receipt.toolId,
        targetCategory: receipt.targetCategory,
        startedAt: receipt.startedAt,
        fileChangeSetIds: receipt.fileChangeSetIds
      }

const fail = (message: string) =>
  Effect.fail(new RuntimeRecoveryError({ message }))

/** Reconcile process-abandoned mutation receipts into session-visible recovery state. */
export class RuntimeRecoveryService extends Effect.Service<RuntimeRecoveryService>()(
  "@jingler/RuntimeRecoveryService",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const paths = yield* AppPaths
      const sessions = yield* SessionStore
      const fs = yield* FileSystem.FileSystem

      const journal = (runId: string) =>
        new RunJournal({ file: join(paths.runJournalsDir, `${runId}.json`) })

      const reconcile = Effect.gen(function* () {
        const exists = yield* fs.exists(paths.runJournalsDir).pipe(
          Effect.orElseSucceed(() => false)
        )
        if (!exists) return [] as ReadonlyArray<UncertainMutationRecovery>
        const entries = yield* fs.readDirectory(paths.runJournalsDir).pipe(
          Effect.mapError(() => new RuntimeRecoveryError({ message: "Could not read runtime journals" }))
        )
        const receipts = yield* Effect.forEach(
          entries.filter((entry) => entry.endsWith(".json")),
          (entry) =>
            journal(entry.slice(0, -5)).reconcileAfterRestart().pipe(
              Effect.orElseSucceed(() => [] as ReadonlyArray<RunReceipt>)
            ),
          { concurrency: "unbounded" }
        )
        const pending = receipts.flat().flatMap((receipt) => {
          const recovery = recoveryOf(receipt)
          return recovery === null || receipt.sessionId === undefined
            ? []
            : [{ sessionId: receipt.sessionId, recovery }]
        })
        const bySession = new Map<string, Array<UncertainMutationRecovery>>()
        for (const { sessionId, recovery } of pending) {
          const current = bySession.get(sessionId) ?? []
          current.push(recovery)
          bySession.set(sessionId, current)
        }
        yield* Effect.forEach(
          bySession,
          ([sessionId, uncertainMutations]) =>
            sessions.setRuntimeRecovery(sessionId, { uncertainMutations }).pipe(
              Effect.orElse(() => Effect.void)
            ),
          { discard: true }
        )
        return pending.map(({ recovery }) => recovery)
      })

      const resolve = (sessionId: string, runId: string, callId: string) =>
        Effect.gen(function* () {
          const session = yield* sessions.get(sessionId).pipe(
            Effect.mapError(() => new RuntimeRecoveryError({ message: "Recovery session no longer exists" }))
          )
          const pending = session.runtimeRecovery?.uncertainMutations.some(
            (mutation) => mutation.runId === runId && mutation.callId === callId
          ) ?? false
          // A banner can outlive its store entry — an earlier click, a second
          // window, or a resolution from before a restart. Resolving something
          // already resolved IS the requested outcome, so hand back the
          // current session (which carries no pending entry) and let the stale
          // banner clear, rather than failing a click that looks like it did
          // nothing.
          if (!pending) return session
          yield* journal(runId).acknowledge(callId).pipe(
            Effect.mapError(() => new RuntimeRecoveryError({ message: "Could not update the runtime journal" }))
          )
          yield* sessions.resolveRuntimeRecovery(sessionId, callId).pipe(
            Effect.mapError(() => new RuntimeRecoveryError({ message: "Could not clear mutation recovery" }))
          )
          return yield* sessions.get(sessionId).pipe(
            Effect.mapError(() => new RuntimeRecoveryError({ message: "Could not reload mutation recovery" }))
          )
        })

      return { reconcile, resolve }
    })
  }
) {}
