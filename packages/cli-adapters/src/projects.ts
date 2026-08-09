import { createHash } from "node:crypto"
import type { CommandExecutor } from "@effect/platform"
import { FileSystem, Path } from "@effect/platform"
import { GitError, Project as ProjectSchema } from "@jingler/core"
import type { Project } from "@jingler/core"
import { Effect, Option, Schema } from "effect"
import { AppPaths } from "./app-paths.js"
import { runGit } from "./command.js"

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
    sync: () => {
      const lock = Effect.unsafeMakeSemaphore(1)

      const readPersisted = (): Effect.Effect<ReadonlyArray<Project>, never, ProjectStoreEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const paths = yield* AppPaths
          const raw = yield* fs.readFileString(paths.projectsFile).pipe(
            Effect.orElseSucceed(() => "")
          )
          if (raw.trim().length === 0) return []
          return yield* Schema.decodeUnknown(Schema.parseJson(ProjectArray))(raw).pipe(
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
          Effect.forEach(projects, availability, { concurrency: 8 }).pipe(
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
                ...(input.environmentId === undefined
                  ? {}
                  : { environmentId: input.environmentId }),
                name: input.name?.trim() || path.basename(resolvedPath),
                path: resolvedPath,
                availability: "available",
                createdAt: existing?.createdAt ?? now,
                updatedAt: now
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
          yield* runGit(null, ["clone", "--", input.url, resolvedPath])
          return yield* register({
            path: resolvedPath,
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.environmentId === undefined
              ? {}
              : { environmentId: input.environmentId })
          })
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
        repositories: ReadonlyArray<RegisterProjectInput>
      ): Effect.Effect<ReadonlyArray<Project>, GitError, ProjectStoreEnv> =>
        Effect.gen(function* () {
          const path = yield* Path.Path
          const unique = new Map<string, RegisterProjectInput>()
          for (const repository of repositories) {
            const resolved = path.resolve(repository.path)
            const key = `${repository.environmentId ?? "local"}\0${resolved}`
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

      return { list, get, register, createDirectory, clone, remove, backfill }
    }
  }
) {}
