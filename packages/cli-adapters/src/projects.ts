import { RoutineStore } from "./routine-store.js"
import { join } from "node:path"
import { readProjectConfig } from "./project-config.js"
import { createHash } from "node:crypto"
import type { CommandExecutor } from "@effect/platform"
import { FileSystem, Path } from "@effect/platform"
import { GitError, Project as ProjectSchema } from "@jingler/core"
import type { Project, Session } from "@jingler/core"
import { Effect, Option, Schema } from "effect"
import { AppPaths } from "./app-paths.js"
import { runGit, runGitWithEnv } from "./command.js"
import { legacyWorkflowBinding, migrateProjectWorkflow, normalizeWorkflow, safeWorkflowRelativePath, type WorkflowDraft } from "./project-workflow.js"

const ProjectArray = Schema.Array(ProjectSchema)
let projectWriteSequence = 0

export interface RegisterProjectInput {
  readonly path: string
  readonly name?: string
  readonly environmentId?: string
}

export interface CloneProjectInput {
  readonly url: string
  readonly destination: string
  readonly name?: string
  readonly environmentId?: string
}

type ProjectStoreEnv = FileSystem.FileSystem | Path.Path | AppPaths

const projectIdFor = (path: string, environmentId?: string): string =>
  `p_${createHash("sha256")
    .update(environmentId ?? "local")
    .update("\0")
    .update(path)
    .digest("hex")
    .slice(0, 20)}`

/** Durable registered repositories. Filesystem availability is refreshed on read. */
export class ProjectService extends Effect.Service<ProjectService>()(
  "@jingler/ProjectService",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const startupFs = yield* FileSystem.FileSystem
      const startupPaths = yield* AppPaths
      const routineStore = new RoutineStore(join(startupPaths.root, "routines.json"))
      // Migrate routines before exposing ANY project writer: otherwise a project
      // save can discard the legacy payload that proves the operator's consent.
      const startupRaw = yield* startupFs.readFileString(startupPaths.projectsFile).pipe(Effect.catchAll(cause =>
        cause._tag === "SystemError" && cause.reason === "NotFound"
          ? Effect.succeed("")
          : Effect.fail(new GitError({ message: "Failed to read legacy workflow bindings", cause }))
      ))
      yield* Effect.tryPromise({ try: async () => {
        if (!startupRaw.trim()) return
        let raw: unknown
        try { raw = JSON.parse(startupRaw) } catch { return }
        if (!Array.isArray(raw)) return
        // Validate the complete catalogue before using any of its identities.
        let catalogue: ReadonlyArray<Project>
        try { catalogue = Schema.decodeUnknownSync(ProjectArray)(raw.map(migrateProjectWorkflow)) } catch { return }
        if (new Set(catalogue.map(project => project.id)).size !== catalogue.length) return
        const bindings = raw.flatMap(project => {
          const binding = legacyWorkflowBinding(project)
          return binding ? [binding] : []
        })
        await routineStore.migrateWorkflowBindings(bindings)
      }, catch: cause => new GitError({ message: "Failed to migrate legacy workflow bindings", cause }) })
      const lock = Effect.unsafeMakeSemaphore(1)

      const readPersisted = (): Effect.Effect<ReadonlyArray<Project>, never, ProjectStoreEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const paths = yield* AppPaths
          const raw = yield* fs.readFileString(paths.projectsFile).pipe(
            Effect.orElseSucceed(() => "")
          )
          if (raw.trim().length === 0) return []
          return yield* Effect.try(() => {
            const data: unknown = JSON.parse(raw)
            return Array.isArray(data) ? data.map(migrateProjectWorkflow) : data
          }).pipe(
            Effect.flatMap(Schema.decodeUnknown(ProjectArray)),
            Effect.orElseSucceed(() => [])
          )
        })

      const writePersisted = (
        projects: ReadonlyArray<Project>
      ): Effect.Effect<void, GitError, ProjectStoreEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const paths = yield* AppPaths
          yield* fs.makeDirectory(paths.root, { recursive: true }).pipe(
            Effect.mapError(
              (cause) => new GitError({ message: "Failed to create the Jingler data directory", cause })
            )
          )
          const encoded = yield* Schema.encode(ProjectArray)(projects).pipe(
            Effect.mapError(
              (cause) => new GitError({ message: "Failed to encode registered projects", cause })
            )
          )
          const temporary = `${paths.projectsFile}.${process.pid}.${++projectWriteSequence}.tmp`
          yield* fs.writeFileString(temporary, `${JSON.stringify(encoded, null, 2)}\n`).pipe(
            Effect.mapError(
              (cause) => new GitError({ message: "Failed to persist registered projects", cause })
            )
          )
          yield* fs.rename(temporary, paths.projectsFile).pipe(
            Effect.mapError(
              (cause) => new GitError({ message: "Failed to persist registered projects", cause })
            ),
            Effect.tapError(() => fs.remove(temporary).pipe(Effect.ignore))
          )
        })

      const availability = (
        project: Project
      ): Effect.Effect<Project, never, FileSystem.FileSystem> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const info = yield* fs.stat(project.path).pipe(Effect.option)
          return {
            ...project,
            availability:
              Option.isSome(info) && info.value.type === "Directory" ? "available" : "missing"
          }
        })

      const list = (): Effect.Effect<ReadonlyArray<Project>, never, ProjectStoreEnv> =>
        Effect.flatMap(readPersisted(), (projects) =>
          Effect.forEach(projects.filter((project) => project.imported === true), availability, { concurrency: 8 }).pipe(
            Effect.map((items) =>
              items.sort((left, right) => left.name.localeCompare(right.name))
            )
          )
        )

      const register = (
        input: RegisterProjectInput
      ): Effect.Effect<Project, GitError, ProjectStoreEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const resolvedPath = path.resolve(input.path)
          const info = yield* fs.stat(resolvedPath).pipe(Effect.option)
          if (Option.isNone(info) || info.value.type !== "Directory") {
            return yield* Effect.fail(
              new GitError({ message: `Project directory does not exist: ${resolvedPath}` })
            )
          }
          const isRepository = yield* fs.exists(path.join(resolvedPath, ".git")).pipe(
            Effect.orElseSucceed(() => false)
          )
          if (!isRepository) {
            return yield* Effect.fail(
              new GitError({ message: `Project directory is not a Git repository: ${resolvedPath}` })
            )
          }
          const now = new Date().toISOString()
          const id = projectIdFor(resolvedPath, input.environmentId)
          return yield* lock.withPermits(1)(
            Effect.gen(function* () {
              const current = yield* readPersisted()
              const existing = current.find((project) => project.id === id)
              const project: Project = {
                id,
                imported: true,
                ...(input.environmentId === undefined
                  ? {}
                  : { environmentId: input.environmentId }),
                name: input.name?.trim() || path.basename(resolvedPath),
                path: resolvedPath,
                availability: "available",
                createdAt: existing?.createdAt ?? now,
                updatedAt: now,
                ...(existing?.workflow === undefined ? {} : { workflow: existing.workflow })
              }
              yield* writePersisted([project, ...current.filter((item) => item.id !== id)])
              return project
            })
          )
        })

      const createDirectory = (
        input: RegisterProjectInput
      ): Effect.Effect<Project, GitError, ProjectStoreEnv | CommandExecutor.CommandExecutor> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const resolvedPath = path.resolve(input.path)
          yield* fs.makeDirectory(resolvedPath, { recursive: false }).pipe(
            Effect.mapError(
              (cause) => new GitError({ message: `Could not create ${resolvedPath}`, cause })
            )
          )
          yield* runGit(resolvedPath, ["init"])
          return yield* register({ ...input, path: resolvedPath })
        })

      const clone = (
        input: CloneProjectInput
      ): Effect.Effect<Project, GitError, ProjectStoreEnv | CommandExecutor.CommandExecutor> =>
        Effect.gen(function* () {
          const path = yield* Path.Path
          const resolvedPath = path.resolve(input.destination)
          // Project preparation also runs on unattended owned-device daemons.
          // Plain `git clone` may open an HTTPS credential prompt, SSH host-key
          // confirmation, or key passphrase prompt with no terminal attached,
          // leaving the desktop on "Preparing project on host" forever. Fail
          // those boundaries promptly; an already-authenticated agent or SSH
          // key continues to work normally.
          yield* runGitWithEnv(
            null,
            [
              "-c", "credential.interactive=never",
              "clone", "--", input.url, resolvedPath
            ],
            {
              GIT_TERMINAL_PROMPT: "0",
              GCM_INTERACTIVE: "Never",
              SSH_ASKPASS_REQUIRE: "never",
              GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10"
            }
          )
          return yield* register({
            path: resolvedPath,
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.environmentId === undefined
              ? {}
              : { environmentId: input.environmentId })
          })
        })

      const setWorkflow = (
        id: string,
        workflow: WorkflowDraft,
        approve: boolean
      ): Effect.Effect<Project, GitError, ProjectStoreEnv> =>
        Effect.gen(function* () {
          const ids = new Set<string>()
          for (const run of workflow.runs) {
            if (!run.id.trim() || !run.label.trim() || !run.command.trim() || ids.has(run.id.trim())) {
              return yield* Effect.fail(new GitError({ message: "Run commands need unique ids, labels, and commands." }))
            }
            ids.add(run.id.trim())
          }
          if (workflow.copyFiles.some((file) => safeWorkflowRelativePath(file) === null)) {
            return yield* Effect.fail(new GitError({ message: "Copied files must use safe repository-relative paths outside .git." }))
          }
          const normalized = yield* Effect.try({ try: () => normalizeWorkflow(workflow, approve), catch: (cause) => new GitError({ message: cause instanceof Error ? cause.message : "Invalid project workflow", cause }) })
          return yield* lock.withPermits(1)(Effect.gen(function* () {
          const current = yield* readPersisted()
          const existing = current.find((project) => project.id === id)
          if (!existing) return yield* Effect.fail(new GitError({ message: `Project not found: ${id}` }))
          const updated: Project = {
            ...existing,
            workflow: normalized,
            updatedAt: new Date().toISOString()
          }
          yield* writePersisted(current.map((project) => project.id === id ? updated : project))
          return updated
          }))
        })

      const remove = (id: string): Effect.Effect<void, GitError, ProjectStoreEnv> =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* readPersisted()
            yield* writePersisted(current.filter((project) => project.id !== id))
          })
        )

      const get = (
        id: string
      ): Effect.Effect<Project, GitError, ProjectStoreEnv> =>
        Effect.gen(function* () {
          const project = (yield* list()).find((item) => item.id === id)
          return project ?? (yield* Effect.fail(new GitError({ message: `Project not found: ${id}` })))
        })

      /** Register each unique legacy repository without mutating the source sessions. */
      const backfill = (
        sessions: ReadonlyArray<Pick<Session, "projectId" | "repoPath" | "repo" | "environmentId">>
      ): Effect.Effect<ReadonlyArray<Project>, GitError, ProjectStoreEnv> =>
        Effect.gen(function* () {
          const path = yield* Path.Path
          const localSessions = sessions.filter((session) => session.environmentId === undefined)
          const sessionProjectIds = new Set(localSessions.map((session) => session.projectId))
          const sessionPaths = new Set(localSessions.flatMap((session) => session.repoPath ? [path.resolve(session.repoPath)] : []))
          yield* lock.withPermits(1)(Effect.gen(function* () {
            const current = yield* readPersisted()
            const recovered = current.map((project) =>
              project.environmentId === undefined &&
              (sessionProjectIds.has(project.id) || sessionPaths.has(project.path)) &&
              project.imported !== true
                ? { ...project, imported: true }
                : project
            )
            if (recovered.some((project, index) => project !== current[index])) yield* writePersisted(recovered)
          }))
          const repositories = localSessions.flatMap((session) =>
            session.repoPath ? [{ path: session.repoPath, name: session.repo }] : []
          )
          const unique = new Map<string, RegisterProjectInput>()
          for (const repository of repositories) {
            const resolved = path.resolve(repository.path)
            const key = resolved
            if (!unique.has(key)) unique.set(key, { ...repository, path: resolved })
          }
          // Legacy records are hints, not authoritative registrations. Deleted
          // worktrees and remote-host paths must not make the whole local
          // catalogue unreadable; register what is valid and leave the rest
          // untouched for the owning session/environment to resolve.
          yield* Effect.forEach(
            [...unique.values()].sort((left, right) => left.path.localeCompare(right.path)),
            (repository) => register(repository).pipe(Effect.either),
            { concurrency: 1, discard: true }
          )
          return yield* list()
        })

      const readConfig = (id: string) => get(id).pipe(Effect.flatMap(readProjectConfig))

      return { routineStore, readConfig, list, get, register, createDirectory, clone, setWorkflow, remove, backfill }
    })
  }
) {}
