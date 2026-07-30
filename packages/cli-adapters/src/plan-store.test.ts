import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs"
import { basename, join } from "node:path"
import { FileSystem, Path } from "@effect/platform"
import { planStageSemanticFingerprint } from "@jingler/core"
import { Chunk, Effect, Either, Layer, Stream } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { scriptedPlan } from "./adapter.js"
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
const SOURCE = `<h1>PRD: Ship safer planning</h1>
<h2>Context</h2>
<p>One document is authoritative.</p>
<section data-stage="01" data-title="Persist the document">
<h3>Intent</h3>
<p>Keep every reader on one revision.</p>
<div data-acceptance="01.1" data-status="pending">The source survives restart.</div>
</section>`

const ORCHESTRATED_SOURCE = `<h1>PRD: Orchestrated change</h1>
<section data-stage="01" data-title="Implement" data-depends-on="" data-complexity="high">
<h3>Intent</h3><p>Ship the change.</p>
<div data-assignment data-agent-id="worker-a" data-cli="codex" data-model="gpt-5.6-sol" data-reason="High complexity implementation." data-status="running"></div>
<div data-acceptance="01.1" data-status="pending">The change is verified.</div>
</section>`

const promote = (source = SOURCE) =>
  PlanStore.promoteDocument(WT, {
    sessionId: "s1",
    producingChatId: "c1",
    id: "plan-1",
    source,
    author: "agent" as const
  })

describe("PlanStore canonical document", () => {
  it("uses one stable current-plan.html with protected frontmatter", async () => {
    const document = await run(promote())
    const files = await run(PlanStore.list(WT))

    expect(document.revision).toBe(1)
    expect(files).toHaveLength(1)
    expect(basename(files[0]!)).toBe("current-plan.html")
    const persisted = readFileSync(files[0]!, "utf8")
    expect(persisted).toContain("jinglerPlan: 1")
    expect(persisted).toContain('sessionId: "s1"')
    // The persisted body is the SANITIZED html, so assert on stable structure
    // (title + stage/acceptance markers) rather than byte-equality with SOURCE.
    expect(persisted).toContain("<h1>PRD: Ship safer planning</h1>")
    expect(persisted).toContain('data-stage="01"')
    expect(persisted).toContain('data-acceptance="01.1"')
    expect(document.projection.title).toBe("PRD: Ship safer planning")
    expect(document.projection.stages[0]?.id).toBe("01")
    expect(document.projection.stages[0]?.acceptance[0]?.id).toBe("01.1")
    expect(planFileName("ignored")).toBe("current-plan")
  })

  it("watch emits the freshly-read document on an external write", async () => {
    // Real filesystem watcher — a fake emitter would pass while `fs.watch`
    // silently no-ops. Mirrors the ThemeService.watch test.
    const first = await run(promote())
    expect(first.revision).toBe(1)
    const file = await run(PlanStore.currentFileFor(WT))
    const c2 = readFileSync(file, "utf8")
      .replace(/^revision:\s*1$/m, "revision: 2")
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
      expect(document?.source).toContain("Edited externally.")
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
          source: SOURCE.replace("survives restart", "survives every restart"),
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
    expect(read?.projection.stages[0]?.acceptance[0]?.text).toBe(
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
          source: SOURCE.replace("One document", "The canonical document"),
          author: "user"
        })
        const stale = yield* Effect.either(
          PlanStore.updateDocument(WT, {
            planId: first.id,
            baseRevision: first.revision,
            source: SOURCE.replace("One document", "A stale local document"),
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

  it("rejects invalid plan HTML before writing a new revision", async () => {
    const result = await run(
      Effect.gen(function* () {
        const first = yield* promote()
        const invalid = yield* Effect.either(
          PlanStore.updateDocument(WT, {
            planId: first.id,
            baseRevision: first.revision,
            // No <h1> title and no <section data-stage> — fails validation.
            source: "<p>no title, no stage</p>",
            author: "user"
          })
        )
        return { first, invalid, current: yield* PlanStore.readDocument(WT) }
      })
    )

    expect(Either.isLeft(result.invalid)).toBe(true)
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
    expect(document.projection.stages[0]?.acceptance[0]).toMatchObject({
      status: "passed",
      evidence: 'Test says "ok" <verified>'
    })
    expect(document.projection.annotations[0]?.body).toBe(
      "Keep {local} text and <Unknown /> inert."
    )
    // The annotation is appended inside its stage's <section>, and the special
    // characters survive as escaped html (never executed).
    expect(document.source).toContain('data-status="passed"')
    expect(document.source.indexOf("data-annotation")).toBeLessThan(
      document.source.indexOf("</section>")
    )
  })

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
                source: SOURCE.replace("One document", label),
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
    const dir = join(temp.root, ".jingler", "terminal")
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  it("rebases concurrent worker evidence onto an orchestrator amendment", async () => {
    const result = await run(
      Effect.gen(function* () {
        const first = yield* promote(ORCHESTRATED_SOURCE)
        yield* Effect.all(
          [
            PlanStore.promoteDocument(WT, {
              sessionId: "s1",
              producingChatId: "c1",
              id: first.id,
              basePlanId: first.id,
              source: ORCHESTRATED_SOURCE.replace(
                "Ship the change.",
                "Ship the amended change."
              ),
              status: "executing",
              author: "agent"
            }),
            PlanStore.setCriterionStatusLatest(WT, {
              planId: first.id,
              criterionId: "01.1",
              status: "passed",
              evidence: "Focused integration test passed."
            })
          ],
          { concurrency: "unbounded" }
        )
        return yield* PlanStore.readDocument(WT)
      })
    )

    expect(result?.source).toContain("Ship the amended change.")
    expect(result?.projection.stages[0]?.acceptance[0]).toMatchObject({
      status: "passed",
      evidence: "Focused integration test passed."
    })
  })

  it("rejects stale worker evidence after the stage semantics change", async () => {
    const result = await run(
      Effect.gen(function* () {
        const first = yield* promote(ORCHESTRATED_SOURCE)
        const oldFingerprint = planStageSemanticFingerprint(
          first.projection.stages[0]!
        )
        const amended = yield* PlanStore.promoteDocument(WT, {
          sessionId: "s1",
          producingChatId: "c1",
          id: "replacement-id",
          basePlanId: first.id,
          source: ORCHESTRATED_SOURCE.replace(
            "The change is verified.",
            "The amended behavior is verified."
          ),
          status: "executing",
          author: "agent"
        })
        yield* PlanStore.setCriterionStatusLatest(WT, {
          planId: first.id,
          stageId: "01",
          criterionId: "01.1",
          status: "passed",
          evidence: "Evidence from the old requirement.",
          expectedStageFingerprint: oldFingerprint
        })
        return {
          amended,
          latest: yield* PlanStore.readDocument(WT)
        }
      })
    )

    expect(result.latest?.revision).toBe(result.amended.revision)
    expect(result.latest?.projection.stages[0]?.acceptance[0]).toMatchObject({
      text: "The amended behavior is verified.",
      status: "pending",
      evidence: null
    })
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
          source: ORCHESTRATED_SOURCE.replace(
            "Ship the change.",
            "Ship the amended change."
          ),
          status: "executing",
          author: "agent"
        })
        yield* PlanStore.setStageExecutionStatus(WT, {
          planId: first.id,
          stageId: "01",
          agentId: "worker-a",
          status: "completed"
        })
        return {
          first,
          amended,
          latest: yield* PlanStore.readDocument(WT)
        }
      })
    )

    expect(result.amended.id).toBe(result.first.id)
    expect(result.latest?.projection.stages[0]?.executionStatus).toBe(
      "completed"
    )
  })

  it("replaces a completed plan with a fresh coordination identity", async () => {
    const result = await run(
      Effect.gen(function* () {
        const first = yield* promote(ORCHESTRATED_SOURCE)
        const completed = yield* PlanStore.updateDocument(WT, {
          planId: first.id,
          baseRevision: first.revision,
          source: first.source,
          author: "agent",
          status: "done"
        })
        const second = yield* PlanStore.promoteDocument(WT, {
          sessionId: "s1",
          producingChatId: "c1",
          id: "plan-2",
          source: ORCHESTRATED_SOURCE.replace("Ship the change.", "Ship plan two."),
          status: "proposed",
          author: "agent"
        })
        return { completed, second }
      })
    )

    expect(result.second.id).toBe("plan-2")
    expect(result.second.revision).toBe(1)
    expect(result.second.source).toContain("Ship plan two.")
    expect(result.second.projection.stages[0]?.executionStatus).toBe("queued")
  })

  it("generates a new coordination id when a fresh plan reuses the completed plan id", async () => {
    const result = await run(
      Effect.gen(function* () {
        const first = yield* promote(ORCHESTRATED_SOURCE)
        yield* PlanStore.writeOrchestrationCheckpoint(WT, first.id, {
          agentId: "worker-a",
          state: "completed",
          completedStageIds: ["01"],
          resumeId: "old-provider-thread",
          message: null,
          attempt: 1
        })
        yield* PlanStore.updateDocument(WT, {
          planId: first.id,
          baseRevision: first.revision,
          source: first.source,
          author: "agent",
          status: "done"
        })
        const second = yield* PlanStore.promoteDocument(WT, {
          sessionId: "s1",
          producingChatId: "c1",
          id: first.id,
          source: ORCHESTRATED_SOURCE.replace(
            "Ship the change.",
            "Ship unrelated work."
          ),
          author: "agent"
        })
        const checkpoints = yield* PlanStore.readOrchestrationCheckpoints(
          WT,
          second.id
        )
        return { first, second, checkpoints }
      })
    )

    expect(result.second.id).not.toBe(result.first.id)
    expect(result.second.revision).toBe(1)
    expect(result.checkpoints).toEqual([])
  })

  it("persists worker checkpoints and exposes running workers as interrupted after restart", async () => {
    const result = await run(
      Effect.gen(function* () {
        const first = yield* promote(ORCHESTRATED_SOURCE)
        yield* PlanStore.writeOrchestrationCheckpoint(WT, first.id, {
          agentId: "worker-a",
          state: "running",
          completedStageIds: [],
          resumeId: "resume-a",
          message: null,
          attempt: 1
        })
        const checkpoints = yield* PlanStore.readOrchestrationCheckpoints(
          WT,
          first.id
        )
        const interrupted = yield* PlanStore.markInterrupted(WT, "s1", "c1")
        return { checkpoints, interrupted }
      })
    )

    expect(result.checkpoints).toEqual([
      {
        agentId: "worker-a",
        state: "running",
        completedStageIds: [],
        resumeId: "resume-a",
        message: null,
        attempt: 1
      }
    ])
    expect(result.interrupted?.status).toBe("stale")
    expect(
      result.interrupted?.projection.stages[0]?.executionStatus
    ).toBe("interrupted")
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
      source: result.proposed.source
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

  it("imports current-plan.json once without losing prose, comments, status, or revision", async () => {
    const dir = join(temp.root, ".jingler", "terminal")
    mkdirSync(dir, { recursive: true })
    const plan = {
      ...scriptedPlan("s1", 1),
      id: "legacy-plan",
      summary: "Legacy migration",
      raw: "Legacy prose with implementation detail.",
      status: "revising" as const,
      comments: [
        {
          id: "comment-1",
          stepId: "step_1",
          body: "Preserve this operator note.",
          author: "user" as const,
          createdAt: "2026-07-01T00:00:00.000Z",
          routed: false
        }
      ]
    }
    writeFileSync(
      join(dir, "current-plan.json"),
      JSON.stringify({
        sessionId: "s1",
        producingChatId: "c1",
        revision: 7,
        plan,
        updatedAt: "2026-07-02T00:00:00.000Z"
      })
    )

    const first = await run(PlanStore.readDocument(WT, "s1", "c1"))
    const second = await run(PlanStore.readDocument(WT, "other", "other"))

    expect(first).not.toBeNull()
    expect(first?.id).toBe("legacy-plan")
    expect(first?.revision).toBe(7)
    expect(first?.status).toBe("revising")
    expect(first?.source).toContain("Legacy prose with implementation detail.")
    expect(first?.projection.annotations[0]?.body).toBe("Preserve this operator note.")
    expect(second).toStrictEqual(first)
    expect(existsSync(join(dir, "current-plan.html"))).toBe(true)
  })

  it("imports legacy arrows and line-leading module prose without failing the read", async () => {
    const dir = join(temp.root, ".jingler", "terminal")
    mkdirSync(dir, { recursive: true })
    const plan = {
      ...scriptedPlan("s1", 1),
      id: "hostile-legacy-plan",
      raw: "import Widget from './widget.js'\nexport const next = true",
      steps: [
        {
          ...scriptedPlan("s1", 1).steps[0]!,
          title: "Rename a -> b"
        }
      ]
    }
    writeFileSync(
      join(dir, "current-plan.json"),
      JSON.stringify({
        sessionId: "s1",
        producingChatId: "c1",
        revision: 3,
        plan,
        updatedAt: "2026-07-02T00:00:00.000Z"
      })
    )

    const imported = await run(PlanStore.readDocument(WT, "s1", "c1"))

    expect(imported).toMatchObject({
      id: "hostile-legacy-plan",
      revision: 3
    })
    expect(imported?.projection.stages[0]?.title).toBe("Rename a -> b")
    expect(existsSync(join(dir, "current-plan.html"))).toBe(true)
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

  it("propagates mechanical progress persistence failures", async () => {
    const first = await run(promote(ORCHESTRATED_SOURCE))
    const dir = join(temp.root, ".jingler", "terminal")
    chmodSync(dir, 0o500)
    try {
      const result = await run(
        Effect.either(
          PlanStore.setStageExecutionStatus(WT, {
            planId: first.id,
            stageId: "01",
            agentId: "worker-a",
            status: "completed"
          })
        )
      )
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("PlanPersistenceError")
      }
    } finally {
      chmodSync(dir, 0o700)
    }
  })

  it("propagates checkpoint persistence failures", async () => {
    const plansDir = join(temp.root, ".jingler")
    mkdirSync(plansDir, { recursive: true })
    writeFileSync(join(plansDir, "terminal"), "not a directory")

    const result = await run(
      Effect.either(
        PlanStore.writeOrchestrationCheckpoint(WT, "plan-1", {
          agentId: "worker-a",
          state: "running",
          completedStageIds: [],
          resumeId: "provider-thread",
          message: null,
          attempt: 1
        })
      )
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("PlanPersistenceError")
    }
  })
})
