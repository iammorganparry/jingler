import type { Plan, SessionPlanArtifact } from "@jingler/core"
import { SessionPlanArtifact as SessionPlanArtifactSchema } from "@jingler/core"
import { FileSystem, Path } from "@effect/platform"
import { Effect, Schema } from "effect"
import { AppPaths } from "./app-paths.js"

type PlanStoreEnv = FileSystem.FileSystem | Path.Path | AppPaths

/** Kebab-case + length-cap a string into a filesystem-safe plan file name. */
export const planFileName = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "plan"

/**
 * The plan library: each session's plans persisted as markdown under
 * `~/jingler/.jingler/<worktree-slug>/<plan-name>.md`. Jingler already captures
 * a plan in the transcript when the agent calls ExitPlanMode; writing it to disk
 * too — in a stable location keyed by the session's worktree — lets a LATER turn
 * or session "pick the plan back up" by reading the file, which the runner points
 * the agent at. All operations are best-effort: a filesystem hiccup never fails a
 * run (planning/implementation proceeds; the transcript remains the source of
 * truth). `worktreePath` is the session's isolated worktree; its basename is the
 * per-session folder, so plans from different sessions never collide.
 */
export class PlanStore extends Effect.Service<PlanStore>()(
  "@jingler/PlanStore",
  {
    accessors: true,
    sync: () => {
      const lock = Effect.unsafeMakeSemaphore(1)
      /** `<plansDir>/<worktree-basename>` — the plan folder for one worktree. */
      const dirFor = (worktreePath: string): Effect.Effect<string, never, Path.Path | AppPaths> =>
        Effect.gen(function* () {
          const path = yield* Path.Path
          const paths = yield* AppPaths
          return path.join(paths.plansDir, path.basename(worktreePath))
        })

      /** `<dir>/<plan-name>.md` — the file for one plan (named from its summary). */
      const fileFor = (
        worktreePath: string,
        plan: Plan
      ): Effect.Effect<string, never, Path.Path | AppPaths> =>
        Effect.gen(function* () {
          const path = yield* Path.Path
          const dir = yield* dirFor(worktreePath)
          return path.join(dir, `${planFileName(plan.summary || plan.id)}.md`)
        })

      /**
       * Persist a plan as markdown, returning its file path. A revised plan with
       * the same summary overwrites its file (latest wins); a distinct plan gets
       * its own file. Best-effort — a write failure yields the intended path
       * without throwing, so the run is never blocked.
       */
      const write = (
        worktreePath: string,
        plan: Plan
      ): Effect.Effect<string, never, PlanStoreEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const dir = yield* dirFor(worktreePath)
          const file = yield* fileFor(worktreePath, plan)
          yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.ignore)
          // Prefer the agent's full plan markdown; fall back to the summary so the
          // file is never empty even for a plan with no raw body.
          const body = plan.raw && plan.raw.trim().length > 0 ? plan.raw : `# ${plan.summary}\n`
          yield* fs.writeFileString(file, body).pipe(Effect.ignore)
          return file
        })

      /**
       * The saved plan files for a worktree (absolute paths, sorted for a stable
       * order), or `[]` when the session has none. The runner reads this to point
       * a resuming agent at its plan(s).
       */
      const list = (
        worktreePath: string
      ): Effect.Effect<ReadonlyArray<string>, never, PlanStoreEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const dir = yield* dirFor(worktreePath)
          const exists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false))
          if (!exists) return []
          const entries = yield* fs
            .readDirectory(dir)
            .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
          return entries
            .filter((e) => e.endsWith(".md"))
            .sort()
            .map((name) => path.join(dir, name))
        })

      const artifactFileFor = (
        worktreePath: string
      ): Effect.Effect<string, never, Path.Path | AppPaths> =>
        Effect.gen(function* () {
          const path = yield* Path.Path
          const dir = yield* dirFor(worktreePath)
          return path.join(dir, "current-plan.json")
        })

      const readArtifact = (
        worktreePath: string
      ): Effect.Effect<SessionPlanArtifact | null, never, PlanStoreEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const file = yield* artifactFileFor(worktreePath)
          const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))
          if (!exists) return null
          const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
          if (raw.trim().length === 0) return null
          return yield* Schema.decodeUnknown(
            Schema.parseJson(SessionPlanArtifactSchema)
          )(raw).pipe(
            Effect.tapError((error) =>
              Effect.logWarning(`Ignoring invalid shared plan artifact ${file}: ${String(error)}`)
            ),
            Effect.orElseSucceed(() => null)
          )
        })

      const writeArtifact = (
        worktreePath: string,
        artifact: SessionPlanArtifact
      ): Effect.Effect<SessionPlanArtifact, never, PlanStoreEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const dir = yield* dirFor(worktreePath)
          const file = yield* artifactFileFor(worktreePath)
          const encoded = yield* Schema.encode(SessionPlanArtifactSchema)(artifact).pipe(
            Effect.orElseSucceed(() => artifact)
          )
          yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.ignore)
          const temp = `${file}.tmp`
          yield* fs
            .writeFileString(temp, JSON.stringify(encoded, null, 2))
            .pipe(
              Effect.andThen(fs.rename(temp, file)),
              Effect.tapError(() => fs.remove(temp).pipe(Effect.ignore)),
              Effect.tapError((error) =>
                Effect.logWarning(`Failed to persist shared plan artifact ${file}: ${String(error)}`)
              ),
              Effect.ignore
            )
          return artifact
        })

      const promote = (
        sessionId: string,
        worktreePath: string,
        producingChatId: string,
        plan: Plan
      ): Effect.Effect<SessionPlanArtifact, never, PlanStoreEnv> =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const prior = yield* readArtifact(worktreePath)
            const artifact: SessionPlanArtifact = {
              sessionId,
              producingChatId,
              revision: (prior?.revision ?? 0) + 1,
              plan,
              updatedAt: new Date().toISOString()
            }
            return yield* writeArtifact(worktreePath, artifact)
          })
        )

      const updateArtifact = (
        worktreePath: string,
        planId: string,
        update: (plan: Plan) => Plan
      ): Effect.Effect<SessionPlanArtifact | null, never, PlanStoreEnv> =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const prior = yield* readArtifact(worktreePath)
            if (prior === null || prior.plan.id !== planId) return null
            return yield* writeArtifact(worktreePath, {
              ...prior,
              revision: prior.revision + 1,
              plan: update(prior.plan),
              updatedAt: new Date().toISOString()
            })
          })
        )

      const rehomeArtifact = (
        worktreePath: string,
        sessionId: string,
        fromChatId: string,
        toChatId: string
      ): Effect.Effect<SessionPlanArtifact | null, never, PlanStoreEnv> =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const prior = yield* readArtifact(worktreePath)
            if (
              prior === null ||
              prior.sessionId !== sessionId ||
              prior.producingChatId !== fromChatId
            ) {
              return prior
            }
            return yield* writeArtifact(worktreePath, {
              ...prior,
              producingChatId: toChatId,
              revision: prior.revision + 1,
              updatedAt: new Date().toISOString()
            })
          })
        )

      const removeAll = (worktreePath: string): Effect.Effect<void, never, PlanStoreEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const dir = yield* dirFor(worktreePath)
          yield* fs.remove(dir, { recursive: true }).pipe(Effect.ignore)
        })

      return {
        write,
        list,
        dirFor,
        fileFor,
        readArtifact,
        promote,
        updateArtifact,
        rehomeArtifact,
        removeAll
      }
    }
  }
) {}
