import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs"
import { basename, join } from "node:path"
import { FileSystem, Path } from "@effect/platform"
import { Effect, Either, Layer } from "effect"
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
const SOURCE = `# PRD: Ship safer planning

## Context

One document is authoritative.

<Stage id="01" title="Persist the document">

### Intent

Keep every reader on one revision.

<Acceptance id="01.1" status="pending">
The source survives restart.
</Acceptance>

</Stage>
`

const promote = (source = SOURCE) =>
  PlanStore.promoteDocument(WT, {
    sessionId: "s1",
    producingChatId: "c1",
    id: "plan-1",
    source,
    author: "agent" as const
  })

describe("PlanStore canonical document", () => {
  it("uses one stable current-plan.mdx with protected frontmatter", async () => {
    const document = await run(promote())
    const files = await run(PlanStore.list(WT))

    expect(document.revision).toBe(1)
    expect(files).toHaveLength(1)
    expect(basename(files[0]!)).toBe("current-plan.mdx")
    const persisted = readFileSync(files[0]!, "utf8")
    expect(persisted).toContain("jinglerPlan: 1")
    expect(persisted).toContain('sessionId: "s1"')
    expect(persisted).toContain(SOURCE.trimStart())
    expect(planFileName("ignored")).toBe("current-plan")
  })

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
    expect(read).toStrictEqual(second)
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

  it("rejects invalid MDX before writing a new revision", async () => {
    const result = await run(
      Effect.gen(function* () {
        const first = yield* promote()
        const invalid = yield* Effect.either(
          PlanStore.updateDocument(WT, {
            planId: first.id,
            baseRevision: first.revision,
            source: "# PRD: unsafe\n\n<Widget value={run()} />",
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
    expect(existsSync(join(dir, "current-plan.mdx"))).toBe(true)
  })
})
