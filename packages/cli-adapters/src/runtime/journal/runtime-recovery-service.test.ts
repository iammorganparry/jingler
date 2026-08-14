import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { SessionStore } from "../../sessions.js"
import { appPathsFor, withTempRoot } from "../../test-support.js"
import { RunJournal } from "./run-journal.js"
import { RuntimeRecoveryService } from "./runtime-recovery-service.js"

const session = {
  id: "session-1",
  repo: "widget",
  branch: "main",
  title: "Recovery",
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-08-10T12:00:00.000Z",
  chats: [{
    id: "chat-1",
    title: null,
    createdAt: "2026-08-10T12:00:00.000Z",
    updatedAt: "2026-08-10T12:00:00.000Z"
  }],
  activeChatId: "chat-1"
} as const

describe("RuntimeRecoveryService", () => {
  const temp = withTempRoot()
  const paths = appPathsFor(temp.root)
  const serviceLayer = RuntimeRecoveryService.Default.pipe(
    Layer.provideMerge(SessionStore.Default),
    Layer.provide(temp.layer)
  )
  const layer = Layer.mergeAll(serviceLayer, temp.layer)

  afterEach(() => temp.cleanup())

  it("surfaces and acknowledges an interrupted mutation without making it retryable", async () => {
    await mkdir(paths.runJournalsDir, { recursive: true })
    await writeFile(paths.sessionsFile, JSON.stringify([session]))
    const journal = new RunJournal({ file: join(paths.runJournalsDir, "run-1.json") })
    await Effect.runPromise(journal.start({
      sessionId: session.id,
      chatId: session.activeChatId,
      callId: "call-1",
      runId: "run-1",
      toolId: "workspace.edit",
      risk: "mutate",
      targetCategory: "workspace"
    }))

    const recovered = await Effect.runPromise(
      Effect.gen(function* () {
        yield* RuntimeRecoveryService.reconcile
        const pending = yield* SessionStore.get(session.id)
        const resolved = yield* RuntimeRecoveryService.resolve(session.id, "run-1", "call-1")
        return { pending, resolved }
      }).pipe(Effect.provide(layer))
    )

    expect(recovered.pending.runtimeRecovery?.uncertainMutations).toMatchObject([
      { runId: "run-1", callId: "call-1", toolId: "workspace.edit" }
    ])
    expect(recovered.resolved.runtimeRecovery).toBeUndefined()
    expect(await Effect.runPromise(journal.list())).toMatchObject([
      { status: "failed", safeToRetry: false, failureCode: "operator-reviewed-uncertain-mutation" }
    ])
  })
})
