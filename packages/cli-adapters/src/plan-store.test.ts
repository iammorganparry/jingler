import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs"
import { basename, dirname, join } from "node:path"
import { FileSystem, Path } from "@effect/platform"
import {
  planStageSemanticFingerprint,
  type PlanPrd,
} from "@jingler/core"
import { Chunk, Effect, Either, Fiber, Layer, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { scriptedPlanPrd } from "./agent-turn-driver.js"
import { AppPaths } from "./app-paths.js"
import { PlanStore, planFileName } from "./plan-store.js"
import { withTempRoot } from "./test-support.js"

let temp: ReturnType<typeof withTempRoot>
beforeEach(() => {
  temp = withTempRoot()
})
afterEach(() => temp.cleanup())

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    PlanStore | FileSystem.FileSystem | Path.Path | AppPaths
  >
) => Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(PlanStore.Default, temp.layer))))

const WT = "/tmp/jingler/worktrees/jingler/terminal"
const SOURCE: PlanPrd = {
  title: "PRD: Ship safer planning",
  sections: [
    {
      id: "context",
      title: "Context",
      blocks: [{ kind: "prose", id: "c1", text: "One document is authoritative." }]
    }
  ],
  stages: [
    {
      id: "01",
      title: "Persist the document",
      intent: "Keep every reader on one revision.",
      approach: [],
      files: [],
      diagrams: [],
      notes: [],
      acceptance: [{ id: "01.1", text: "The source survives restart.", status: "pending", evidence: null }],
      dependencies: []
    }
  ],
  annotations: []
}

const ORCHESTRATED_SOURCE: PlanPrd = {
  title: "PRD: Orchestrated change",
  sections: [],
  stages: [
    {
      id: "01",
      title: "Implement",
      intent: "Ship the change.",
      approach: [],
      files: [],
      diagrams: [],
      notes: [],
      acceptance: [{ id: "01.1", text: "The change is verified.", status: "pending", evidence: null }],
      dependencies: [],
      complexity: "high"
    }
  ],
  annotations: []
}

/** Structured edits replacing the former HTML `.replace()` fixture mutations. */
const editProse = (plan: PlanPrd, text: string): PlanPrd => ({
  ...plan,
  sections: plan.sections.map((s, i) => (i === 0 ? { ...s, blocks: [{ kind: "prose", id: "c1", text }] } : s))
})
const editAcceptanceText = (plan: PlanPrd, text: string): PlanPrd => ({
  ...plan,
  stages: plan.stages.map((s, i) =>
    i === 0 ? { ...s, acceptance: s.acceptance.map((c, j) => (j === 0 ? { ...c, text } : c)) } : s
  )
})
const editIntent = (plan: PlanPrd, intent: string): PlanPrd => ({
  ...plan,
  stages: plan.stages.map((s, i) => (i === 0 ? { ...s, intent } : s))
})

const promote = (plan = SOURCE) =>
  PlanStore.promoteDocument(WT, {
    sessionId: "s1",
    producingChatId: "c1",
    id: "plan-1",
    plan,
    author: "agent" as const
  })

describe("PlanStore canonical document", () => {
  it("uses one stable current-plan.json with protected frontmatter", async () => {
    const document = await run(promote())
    const files = await run(PlanStore.list(WT))

    expect(document.revision).toBe(1)
    expect(files).toHaveLength(1)
    expect(basename(files[0]!)).toBe("current-plan.json")
    const persisted = JSON.parse(readFileSync(files[0]!, "utf8"))
    expect(persisted.sessionId).toBe("s1")
    // The persisted body is the structured plan DTO, not HTML.
    expect(persisted.plan.title).toBe("PRD: Ship safer planning")
    expect(persisted.plan.stages[0].id).toBe("01")
    expect(persisted.plan.stages[0].acceptance[0].id).toBe("01.1")
    expect(document.plan.title).toBe("PRD: Ship safer planning")
    expect(document.plan.stages[0]?.id).toBe("01")
    expect(document.plan.stages[0]?.acceptance[0]?.id).toBe("01.1")
    expect(planFileName("ignored")).toBe("current-plan")
  })

  it("isolates same-basename repositories and deletes only the requested plans", async () => {
    const firstPath = "/tmp/one/widget"
    const secondPath = "/tmp/two/widget"
    await run(
      Effect.gen(function* () {
        yield* PlanStore.promoteDocument(firstPath, {
          sessionId: "s-one",
          producingChatId: "c-one",
          id: "plan-one",
          plan: SOURCE,
          author: "agent"
        })
        yield* PlanStore.promoteDocument(secondPath, {
          sessionId: "s-two",
          producingChatId: "c-two",
          id: "plan-two",
          plan: SOURCE,
          author: "agent"
        })
      })
    )

    const firstFiles = await run(PlanStore.list(firstPath))
    const secondFiles = await run(PlanStore.list(secondPath))
    expect(dirname(firstFiles[0]!)).not.toBe(dirname(secondFiles[0]!))

    await run(PlanStore.removeAll(firstPath))
    expect(await run(PlanStore.list(firstPath))).toStrictEqual([])
    expect(await run(PlanStore.list(secondPath))).toHaveLength(1)
  })

  it("reconcile:true applies a selected-agent amendment and retains evidence", async () => {
    const firstStage = {
      id: "01",
      title: "First",
      intent: "First.",
      approach: [],
      tasks: [{ id: "01.task", text: "Implement first", status: "completed" as const }],
      files: [{ path: "a.ts", change: "M" as const }],
      diagrams: [],
      notes: [],
      dependencies: [],
      complexity: "high" as const
    }
    const base: PlanPrd = {
      title: "PRD: Amend",
      sections: [],
      stages: [{
        ...firstStage,
        acceptance: [{ id: "01.1", text: "The first is done.", status: "passed", evidence: "landed in abc123" }]
      }],
      annotations: []
    }
    const initial = await run(promote(base))
    const amendment: PlanPrd = {
      title: "PRD: Amend",
      sections: [],
      stages: [
        {
          ...firstStage,
          tasks: [{ id: "01.task", text: "Implement first", status: "pending" }],
          acceptance: [{ id: "01.1", text: "The first is done.", status: "pending", evidence: null }]
        },
        {
          id: "02",
          title: "Second",
          intent: "Second.",
          approach: [],
          tasks: [{ id: "02.task", text: "Implement second", status: "pending" }],
          files: [{ path: "b.ts", change: "M" }],
          diagrams: [],
          notes: [],
          acceptance: [{ id: "02.1", text: "The second is done.", status: "pending", evidence: null }],
          dependencies: [],
          complexity: "high"
        }
      ],
      annotations: []
    }
    const amended = await run(
      PlanStore.updateDocument(WT, {
        planId: "plan-1",
        baseRevision: initial.revision,
        plan: amendment,
        author: "agent",
        reconcile: true,
        status: "executing"
      })
    )
    expect(amended.revision).toBe(initial.revision + 1)
    expect(amended.plan.stages[0]?.tasks?.[0]?.status).toBe("completed")
    expect(amended.plan.stages[0]?.acceptance[0]).toMatchObject({
      status: "passed",
      evidence: "landed in abc123"
    })
    expect(amended.plan.stages[1]?.tasks?.[0]?.status).toBe("pending")
  })

  it("watch emits the freshly-read document on an external write", async () => {
    // Real filesystem watcher — a fake emitter would pass while `fs.watch`
    // silently no-ops. Mirrors the ThemeService.watch test.
    const first = await run(promote())
    expect(first.revision).toBe(1)
    const file = await run(PlanStore.currentFileFor(WT))
    const c2 = readFileSync(file, "utf8")
      .replace('"revision": 1', '"revision": 2')
      .replace("One document is authoritative.", "Edited externally.")

    // Rewrite idempotently until the (async-attaching) watcher delivers an
    // event; `Stream.take(1)` then completes. The interval MUST exceed the
    // watch debounce (150ms) or every write resets the debounce timer and it
    // never fires.
    const interval = setInterval(() => {
      try {
        writeFileSync(file, c2)
      } catch {
        // ignore mid-rename races
      }
    }, 300)
    try {
      const chunk = await run(
        Stream.unwrap(Effect.map(PlanStore, (s) => s.watch(WT))).pipe(
          Stream.take(1),
          Stream.runCollect
        )
      )
      const document = Chunk.toReadonlyArray(chunk)[0]
      expect(document?.revision).toBe(2)
      expect(JSON.stringify(document?.plan)).toContain("Edited externally.")
    } finally {
      clearInterval(interval)
    }
  }, 15_000)

  it("round-trips the canonical source and monotonically increments revisions", async () => {
    const { first, second, read } = await run(
      Effect.gen(function* () {
        const first = yield* promote()
        const second = yield* PlanStore.updateDocument(WT, {
          planId: first.id,
          baseRevision: first.revision,
          plan: editAcceptanceText(SOURCE, "The source survives every restart."),
          author: "user"
        })
        const read = yield* PlanStore.readDocument(WT)
        return { first, second, read }
      })
    )

    expect(first.revision).toBe(1)
    expect(second.revision).toBe(2)
    expect(second.updatedBy).toBe("user")
    // Assert the parsed projection round-trips (not raw-string identity — the
    // store persists sanitized html): the reopened document is the last write.
    expect(read).toStrictEqual(second)
    expect(read?.plan.stages[0]?.acceptance[0]?.text).toBe(
      "The source survives every restart."
    )
  })

  it("returns the latest document on a stale compare-and-swap without overwriting", async () => {
    const result = await run(
      Effect.gen(function* () {
        const first = yield* promote()
        const second = yield* PlanStore.updateDocument(WT, {
          planId: first.id,
          baseRevision: first.revision,
          plan: editProse(SOURCE, "The canonical document is authoritative."),
          author: "user"
        })
        const stale = yield* Effect.either(
          PlanStore.updateDocument(WT, {
            planId: first.id,
            baseRevision: first.revision,
            plan: editProse(SOURCE, "A stale local document is authoritative."),
            author: "user"
          })
        )
        return { second, stale, current: yield* PlanStore.readDocument(WT) }
      })
    )

    expect(Either.isLeft(result.stale)).toBe(true)
    if (Either.isLeft(result.stale)) {
      expect(result.stale.left._tag).toBe("PlanConflictError")
      if (result.stale.left._tag === "PlanConflictError") {
        expect(result.stale.left.latest).toStrictEqual(result.second)
      }
    }
    expect(result.current).toStrictEqual(result.second)
  })

  it("rejects a structurally invalid plan before writing a new revision", async () => {
    const result = await run(
      Effect.gen(function* () {
        const first = yield* promote()
        const invalid = yield* Effect.either(
          PlanStore.updateDocument(WT, {
            planId: first.id,
            baseRevision: first.revision,
            // Missing `stages`/`annotations` — fails Schema validation.
            plan: { title: "broken", sections: [] } as unknown as PlanPrd,
            author: "agent"
          })
        )
        return { first, invalid, current: yield* PlanStore.readDocument(WT) }
      })
    )

    expect(Either.isLeft(result.invalid)).toBe(true)
    expect(result.current).toStrictEqual(result.first)
  })

  it("rejects a schema-valid but structurally broken plan (duplicate ids collapse targets)", async () => {
    // Passes Schema decoding, but the duplicate stage/acceptance ids would make
    // downstream id-keyed views and mutations address the wrong target.
    const duplicated: PlanPrd = {
      ...SOURCE,
      stages: [
        SOURCE.stages[0]!,
        { ...SOURCE.stages[0]!, title: "Colliding twin" }
      ]
    }
    const result = await run(
      Effect.gen(function* () {
        const first = yield* promote()
        const invalid = yield* Effect.either(
          PlanStore.updateDocument(WT, {
            planId: first.id,
            baseRevision: first.revision,
            plan: duplicated,
            author: "agent"
          })
        )
        return { first, invalid, current: yield* PlanStore.readDocument(WT) }
      })
    )

    expect(Either.isLeft(result.invalid)).toBe(true)
    // The canonical document is untouched — the broken plan never persisted.
    expect(result.current).toStrictEqual(result.first)
  })

  it("updates criteria and annotations without executing or losing special text", async () => {
    const document = await run(
      Effect.gen(function* () {
        const first = yield* promote()
        const criterion = yield* PlanStore.setCriterionStatus(WT, {
          planId: first.id,
          baseRevision: first.revision,
          criterionId: "01.1",
          status: "passed",
          evidence: 'Test says "ok" <verified>',
          author: "user"
        })
        return yield* PlanStore.addAnnotation(WT, {
          planId: criterion.id,
          baseRevision: criterion.revision,
          stageId: "01",
          body: "Keep {local} text and <Unknown /> inert.",
          author: "user"
        })
      })
    )

    expect(document.revision).toBe(3)
    expect(document.plan.stages[0]?.acceptance[0]).toMatchObject({
      status: "passed",
      evidence: 'Test says "ok" <verified>'
    })
    expect(document.plan.annotations[0]?.body).toBe(
      "Keep {local} text and <Unknown /> inert."
    )
    // The annotation is attached to its stage, and special characters survive
    // verbatim in the structured DTO (no escaping/execution).
    expect(document.plan.annotations[0]?.stageId).toBe("01")
    expect(document.plan.stages[0]?.acceptance[0]?.status).toBe("passed")
  })

  it("persists task progress without changing plan semantics", async () => {
    const source: PlanPrd = {
      ...SOURCE,
      stages: SOURCE.stages.map((stage) => ({
        ...stage,
        tasks: [
          { id: "01.task.1", text: "Add the mutation", status: "pending" },
          { id: "01.task.2", text: "Verify persistence", status: "pending" }
        ]
      }))
    }

    const result = await run(
      Effect.gen(function* () {
        const first = yield* promote(source)
        const before = planStageSemanticFingerprint(first.plan.stages[0]!)
        const updated = yield* PlanStore.setTaskStatusLatest(WT, {
          planId: first.id,
          stageId: "01",
          taskId: "01.task.1",
          status: "in-progress",
          expectedStageFingerprint: before
        })
        const restored = yield* PlanStore.readDocument(WT)
        return { first, before, updated, restored }
      })
    )

    expect(result.updated?.revision).toBe(result.first.revision + 1)
    expect(result.restored?.plan.stages[0]?.tasks).toEqual([
      { id: "01.task.1", text: "Add the mutation", status: "in-progress" },
      { id: "01.task.2", text: "Verify persistence", status: "pending" }
    ])
    expect(planStageSemanticFingerprint(result.restored!.plan.stages[0]!)).toBe(
      result.before
    )
  })

  it("derives durable stage progress and never regresses a completed task", async () => {
    const source: PlanPrd = {
      ...SOURCE,
      stages: SOURCE.stages.map((stage) => ({
        ...stage,
        tasks: [
          { id: "01.task.1", text: "Add the mutation", status: "pending" as const },
          { id: "01.task.2", text: "Verify persistence", status: "pending" as const }
        ]
      }))
    }

    const result = await run(
      Effect.gen(function* () {
        const first = yield* promote(source)
        const fingerprint = planStageSemanticFingerprint(first.plan.stages[0]!)
        yield* PlanStore.setTaskStatusLatest(WT, {
          planId: first.id,
          stageId: "01",
          taskId: "01.task.1",
          status: "completed",
          expectedStageFingerprint: fingerprint
        })
        const afterFirst = yield* PlanStore.readDocument(WT)
        yield* PlanStore.setTaskStatusLatest(WT, {
          planId: first.id,
          stageId: "01",
          taskId: "01.task.1",
          status: "in-progress",
          expectedStageFingerprint: fingerprint
        })
        yield* PlanStore.setTaskStatusLatest(WT, {
          planId: first.id,
          stageId: "01",
          taskId: "01.task.2",
          status: "completed",
          expectedStageFingerprint: fingerprint
        })
        return {
          afterFirst,
          restored: yield* PlanStore.readDocument(WT)
        }
      })
    )

    expect(result.afterFirst?.plan.stages[0]).toMatchObject({
      tasks: [
        { id: "01.task.1", status: "completed" },
        { id: "01.task.2", status: "pending" }
      ]
    })
    expect(result.restored?.plan.stages[0]).toMatchObject({
      tasks: [
        { id: "01.task.1", status: "completed" },
        { id: "01.task.2", status: "completed" }
      ]
    })
  })

  it("revision-guards appending, delivery updates, and thread resolution", async () => {
    const result = await run(
      Effect.gen(function* () {
        const first = yield* promote()
        const thread = yield* PlanStore.addAnnotation(WT, {
          planId: first.id,
          baseRevision: first.revision,
          stageId: "01",
          body: "Please ask worker-a.",
          author: "user"
        })
        const replied = yield* PlanStore.appendAnnotationMessage(WT, {
          planId: first.id,
          baseRevision: thread.revision,
          annotationId: thread.plan.annotations[0]!.id,
          body: "I checked the persistence path.",
          authorKind: "agent",
          authorId: "worker-a",
          mentionedParticipantIds: ["operator", "operator"],
          deliveryState: "pending"
        })
        const reply = replied.plan.annotations[0]!.messages[1]!
        const sent = yield* PlanStore.updateAnnotationMessageDelivery(WT, {
          planId: first.id,
          baseRevision: replied.revision,
          annotationId: replied.plan.annotations[0]!.id,
          messageId: reply.id,
          deliveryState: "sent",
          author: "agent"
        })
        const withOutbox = yield* PlanStore.updateAnnotationMentionDeliveries(WT, {
          planId: first.id,
          baseRevision: sent.revision,
          annotationId: sent.plan.annotations[0]!.id,
          messageId: reply.id,
          deliveries: [
            {
              participantId: "operator",
              status: "delivered",
              dispatchId: `${reply.id}:operator`,
              detail: null,
              retryable: false
            }
          ],
          deliveryState: "sent",
          author: "agent"
        })
        const resolved = yield* PlanStore.setAnnotationResolved(WT, {
          planId: first.id,
          baseRevision: withOutbox.revision,
          annotationId: withOutbox.plan.annotations[0]!.id,
          resolved: true,
          author: "user"
        })
        const reopened = yield* PlanStore.setAnnotationResolved(WT, {
          planId: first.id,
          baseRevision: resolved.revision,
          annotationId: resolved.plan.annotations[0]!.id,
          resolved: false,
          author: "user"
        })
        const stale = yield* Effect.either(
          PlanStore.appendAnnotationMessage(WT, {
            planId: first.id,
            baseRevision: thread.revision,
            annotationId: thread.plan.annotations[0]!.id,
            body: "Stale reply.",
            authorKind: "user",
            authorId: "operator",
            mentionedParticipantIds: [],
            deliveryState: "pending"
          })
        )
        return { thread, replied, sent, withOutbox, resolved, reopened, stale }
      })
    )

    expect(result.replied.plan.annotations[0]?.messages).toEqual([
      expect.objectContaining({
        body: "Please ask worker-a.",
        authorKind: "user",
        deliveryState: "sent"
      }),
      expect.objectContaining({
        body: "I checked the persistence path.",
        authorKind: "agent",
        authorId: "worker-a",
        mentionedParticipantIds: ["operator"],
        deliveryState: "pending"
      })
    ])
    expect(result.sent.plan.annotations[0]?.messages[1]?.deliveryState).toBe("sent")
    expect(
      result.withOutbox.plan.annotations[0]?.messages[1]?.mentionDeliveries
    ).toEqual([
      expect.objectContaining({ participantId: "operator", status: "delivered" })
    ])
    expect(result.resolved.plan.annotations[0]?.status).toBe("resolved")
    expect(result.reopened.plan.annotations[0]?.status).toBe("open")
    expect(Either.isLeft(result.stale)).toBe(true)
    if (Either.isLeft(result.stale)) {
      expect(result.stale.left).toMatchObject({
        _tag: "PlanConflictError",
        latestRevision: result.reopened.revision,
        latest: result.reopened
      })
    }
  })

  it("publishes a revision-guarded thread append through PlanStore.watch", async () => {
    const result = await run(
      Effect.gen(function* () {
        const first = yield* promote()
        const thread = yield* PlanStore.addAnnotation(WT, {
          planId: first.id,
          baseRevision: first.revision,
          stageId: "01",
          body: "Initial question.",
          author: "user"
        })
        const watchedFiber = yield* Stream.unwrap(
          Effect.map(PlanStore, (store) => store.watch(WT, "s1", "c1"))
        ).pipe(Stream.take(1), Stream.runCollect, Effect.fork)
        yield* Effect.sleep("25 millis")
        const appended = yield* PlanStore.appendAnnotationMessage(WT, {
          planId: first.id,
          baseRevision: thread.revision,
          annotationId: thread.plan.annotations[0]!.id,
          body: "Durable reply.",
          authorKind: "agent",
          authorId: "planner",
          mentionedParticipantIds: ["operator"],
          deliveryState: "sent"
        })
        const watched = Chunk.toReadonlyArray(yield* Fiber.join(watchedFiber))[0]
        return { appended, watched }
      })
    )

    expect(result.watched?.revision).toBe(result.appended.revision)
    expect(result.watched?.plan.annotations[0]?.messages[1]).toMatchObject({
      body: "Durable reply.",
      authorId: "planner",
      deliveryState: "sent"
    })
  }, 15_000)

  it("serializes concurrent writers so one wins and one receives a conflict", async () => {
    const results = await run(
      Effect.gen(function* () {
        const first = yield* promote()
        return yield* Effect.all(
          ["Writer A", "Writer B"].map((label) =>
            Effect.either(
              PlanStore.updateDocument(WT, {
                planId: first.id,
                baseRevision: first.revision,
                plan: editProse(SOURCE, ` is authoritative.`),
                author: "user"
              })
            )
          ),
          { concurrency: "unbounded" }
        )
      })
    )

    expect(results.filter(Either.isRight)).toHaveLength(1)
    expect(results.filter(Either.isLeft)).toHaveLength(1)
    const dir = dirname((await run(PlanStore.list(WT)))[0]!)
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  it("keeps the canonical plan identity when an amendment carries a fresh proposal id", async () => {
    const result = await run(
      Effect.gen(function* () {
        const first = yield* promote(ORCHESTRATED_SOURCE)
        const amended = yield* PlanStore.promoteDocument(WT, {
          sessionId: "s1",
          producingChatId: "c1",
          id: "fresh-planner-proposal-id",
          basePlanId: first.id,
          plan: editIntent(ORCHESTRATED_SOURCE, "Ship the amended change."),
          status: "executing",
          author: "agent"
        })
        return {
          first,
          amended,
          latest: yield* PlanStore.readDocument(WT)
        }
      })
    )

    expect(result.amended.id).toBe(result.first.id)
  })

  it("replaces a completed plan with a fresh coordination identity", async () => {
    const result = await run(
      Effect.gen(function* () {
        const first = yield* promote(ORCHESTRATED_SOURCE)
        const completed = yield* PlanStore.updateDocument(WT, {
          planId: first.id,
          baseRevision: first.revision,
          plan: first.plan,
          author: "agent",
          status: "done"
        })
        const second = yield* PlanStore.promoteDocument(WT, {
          sessionId: "s1",
          producingChatId: "c1",
          id: "plan-2",
          plan: editIntent(ORCHESTRATED_SOURCE, "Ship plan two."),
          status: "proposed",
          author: "agent"
        })
        return { completed, second }
      })
    )

    expect(result.second.id).toBe("plan-2")
    expect(result.second.revision).toBe(1)
    expect(result.second.plan.stages[0]?.intent).toBe("Ship plan two.")
  })

  it("generates a new coordination id when a fresh plan reuses the completed plan id", async () => {
    const result = await run(
      Effect.gen(function* () {
        const first = yield* promote(ORCHESTRATED_SOURCE)
        yield* PlanStore.updateDocument(WT, {
          planId: first.id,
          baseRevision: first.revision,
          plan: first.plan,
          author: "agent",
          status: "done"
        })
        const second = yield* PlanStore.promoteDocument(WT, {
          sessionId: "s1",
          producingChatId: "c1",
          id: first.id,
          plan: editIntent(ORCHESTRATED_SOURCE, "Ship unrelated work."),
          author: "agent"
        })
        return { first, second }
      })
    )

    expect(result.second.id).not.toBe(result.first.id)
    expect(result.second.revision).toBe(1)
  })

  it("marks an interrupted in-flight revision stale without changing its source", async () => {
    const result = await run(
      Effect.gen(function* () {
        const proposed = yield* promote()
        const stale = yield* PlanStore.markInterrupted(WT, "s1", "c1")
        const unchanged = yield* PlanStore.markInterrupted(WT, "s1", "c1")
        return { proposed, stale, unchanged }
      })
    )

    expect(result.stale).toMatchObject({
      status: "stale",
      revision: 2,
      plan: result.proposed.plan
    })
    expect(result.unchanged).toStrictEqual(result.stale)
  })

  it("does not stale a plan created after startup recovery began", async () => {
    const result = await run(
      Effect.gen(function* () {
        const proposed = yield* promote()
        const recovered = yield* PlanStore.markInterrupted(
          WT,
          "s1",
          "c1",
          "2000-01-01T00:00:00.000Z"
        )
        return { proposed, recovered }
      })
    )

    expect(result.recovered).toStrictEqual(result.proposed)
    expect(result.recovered?.status).toBe("proposed")
    expect(result.recovered?.revision).toBe(1)
  })

  it("returns a typed persistence error instead of dying when the target is unwritable", async () => {
    const plansDir = join(temp.root, ".jingler")
    mkdirSync(plansDir, { recursive: true })
    writeFileSync(join(plansDir, "terminal"), "not a directory")

    const result = await run(Effect.either(promote()))

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("PlanPersistenceError")
    }
  })
})
