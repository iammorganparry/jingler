import { randomUUID } from "node:crypto"
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative } from "node:path"
import {
  type DetectedResourceCandidate,
  ManagedResource,
  type ManagedResourceId,
  type ManagedResourceScope,
  type ResourceImportDiagnostic,
  type ResourceImportResult
} from "@jingler/core"
import { Context, Data, Effect, PubSub, Schema, Stream } from "effect"
import { AtomicJsonFile } from "../persistence/atomic-json-file.js"

const MAX_RESOURCE_BYTES = 256 * 1024
const ResourceCatalog = Schema.Array(ManagedResource)

export class AgentResourceError extends Data.TaggedError("AgentResourceError")<{
  readonly operation: "list" | "import" | "remove" | "reveal" | "enable"
  readonly message: string
}> {}

export interface AgentResourceServiceShape {
  readonly list: Effect.Effect<ReadonlyArray<ManagedResource>, AgentResourceError>
  readonly importResources: (
    candidates: ReadonlyArray<DetectedResourceCandidate>,
    scope: ManagedResourceScope
  ) => Effect.Effect<ResourceImportResult, AgentResourceError>
  readonly remove: (id: ManagedResourceId) => Effect.Effect<void, AgentResourceError>
  readonly reveal: (id: ManagedResourceId) => Effect.Effect<string, AgentResourceError>
  readonly setEnabled: (
    id: ManagedResourceId,
    enabled: boolean
  ) => Effect.Effect<void, AgentResourceError>
  readonly enabledForTarget: (
    targetId: string
  ) => Effect.Effect<ReadonlyArray<ManagedResource>, AgentResourceError>
  readonly watch: () => Stream.Stream<ReadonlyArray<ManagedResource>>
}

export class AgentResourceService extends Context.Tag("@jingler/AgentResourceService")<
  AgentResourceService,
  AgentResourceServiceShape
>() {}

interface AgentResourceServiceOptions {
  readonly managedRoot: string
}

const decodeCatalog = (raw: string): ReadonlyArray<ManagedResource> =>
  Schema.decodeUnknownSync(Schema.parseJson(ResourceCatalog))(raw)

const inside = (root: string, target: string): boolean => {
  const nested = relative(root, target)
  return nested === "" || (!nested.startsWith("..") && !isAbsolute(nested))
}

const diagnostic = (
  candidate: DetectedResourceCandidate,
  code: ResourceImportDiagnostic["code"],
  message: string
): ResourceImportDiagnostic => ({
  sourcePath: candidate.provenance.sourcePath,
  kind: candidate.kind,
  code,
  message
})

const supportsTarget = (scope: ManagedResourceScope, targetId: string): boolean =>
  scope.kind === "device-local"
    ? scope.targetId === targetId
    : scope.allowedTargets.length === 0 || scope.allowedTargets.includes(targetId)

const nextId = async (
  requested: ManagedResourceId,
  catalog: ReadonlyArray<ManagedResource>,
  root: string,
  kind: "skill" | "prompt"
): Promise<ManagedResourceId> => {
  const used = new Set(catalog.map((resource) => resource.id))
  let suffix = 1
  while (true) {
    const candidate = (suffix === 1 ? requested : `${requested}-${suffix}`) as ManagedResourceId
    if (!used.has(candidate)) {
      const exists = await stat(targetFor(root, kind, candidate)).then(() => true, () => false)
      if (!exists) return candidate
    }
    suffix += 1
  }
}

const targetFor = (root: string, kind: "skill" | "prompt", id: ManagedResourceId): string =>
  kind === "skill" ? join(root, "skills", id, "SKILL.md") : join(root, "prompts", `${id}.md`)

const serviceError = (
  operation: AgentResourceError["operation"],
  message: string
): AgentResourceError => new AgentResourceError({ operation, message })

/**
 * Jingler-owned resource catalog. All mutations are serialized by AtomicJsonFile;
 * source and destination confinement is rechecked at the moment of mutation.
 */
export const makeAgentResourceService = (
  options: AgentResourceServiceOptions
): Effect.Effect<AgentResourceServiceShape> =>
  Effect.gen(function* () {
    const root = options.managedRoot
    const catalog = new AtomicJsonFile<ReadonlyArray<ManagedResource>>({
      file: join(root, "catalog.json"),
      decode: decodeCatalog,
      fallback: () => []
    })
    const changes = yield* PubSub.unbounded<ReadonlyArray<ManagedResource>>()

    const list = Effect.tryPromise({
      try: () => catalog.read(),
      catch: () => serviceError("list", "Could not read the managed resource catalog")
    })

    const publish = (resources: ReadonlyArray<ManagedResource>) =>
      PubSub.publish(changes, resources).pipe(Effect.asVoid)

    const importOne = (
      candidate: DetectedResourceCandidate,
      scope: ManagedResourceScope
    ): Effect.Effect<ManagedResourceId, ResourceImportDiagnostic> => {
      const kind = candidate.kind

      return Effect.tryPromise({
        try: async () => {
          const sourceRoot = await realpath(candidate.provenance.sourceRoot)
          const source = await realpath(candidate.provenance.sourcePath)
          if (!inside(sourceRoot, source)) {
            throw new Error("Resource source escapes its detected root")
          }
          const sourceInfo = await stat(source)
          if (!sourceInfo.isFile()) throw new Error("Resource source is not a file")
          if (sourceInfo.size > MAX_RESOURCE_BYTES) throw new Error("Resource exceeds the 256 KiB import limit")
          const content = await readFile(source, "utf8")
          let importedId: ManagedResourceId | null = null
          let createdPath: string | null = null

          try {
            await catalog.update(async (current) => {
              const id = await nextId(candidate.id, current, root, kind)
              const target = targetFor(root, kind, id)
              if (!inside(root, target)) throw new Error("Managed destination escapes its root")
              await mkdir(dirname(target), { recursive: true })
              const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
              try {
                await writeFile(temporary, content, { encoding: "utf8", flag: "wx" })
                await rename(temporary, target)
              } catch (error) {
                await rm(temporary, { force: true }).catch(() => undefined)
                throw error
              }
              importedId = id
              createdPath = target
              return [
                ...current,
                {
                  id,
                  kind,
                  name: candidate.name,
                  description: candidate.description,
                  enabled: true,
                  trust: "operator-approved",
                  scope,
                  managedPath: target,
                  byteLength: Buffer.byteLength(content),
                  provenance: {
                    ...candidate.provenance,
                    importedAt: new Date().toISOString()
                  }
                }
              ]
            })
          } catch (error) {
            if (createdPath !== null) {
              const importedPath: string = createdPath
              const cleanup = kind === "skill" ? dirname(importedPath) : importedPath
              await rm(cleanup, { recursive: kind === "skill", force: true }).catch(() => undefined)
            }
            throw error
          }
          if (importedId === null) throw new Error("Resource import did not produce an id")
          return importedId
        },
        catch: (cause) => diagnostic(
          candidate,
          cause instanceof Error && cause.message.includes("256 KiB") ? "oversized" : "malformed",
          cause instanceof Error ? cause.message : "Resource could not be imported"
        )
      })
    }

    const importResources = (
      candidates: ReadonlyArray<DetectedResourceCandidate>,
      scope: ManagedResourceScope
    ): Effect.Effect<ResourceImportResult, AgentResourceError> =>
      Effect.forEach(candidates, (candidate) =>
        importOne(candidate, scope).pipe(
          Effect.match({
            onFailure: (error) => ({ _tag: "skipped" as const, diagnostic: error }),
            onSuccess: (id) => ({ _tag: "imported" as const, id })
          })
        ), { concurrency: 1 }).pipe(
          Effect.flatMap((results) => {
            return list.pipe(
              Effect.tap(publish),
              Effect.as({
                imported: results.flatMap((result) => result._tag === "imported" ? [result.id] : []),
                skipped: results.flatMap((result) => result._tag === "skipped" ? [result.diagnostic] : [])
              })
            )
          })
        )

    const resourceById = (id: ManagedResourceId, operation: AgentResourceError["operation"]) =>
      list.pipe(
        Effect.flatMap((resources) => {
          const resource = resources.find((item) => item.id === id)
          return resource === undefined
            ? Effect.fail(serviceError(operation, `Managed resource "${id}" does not exist`))
            : Effect.succeed(resource)
        })
      )

    const reveal = (id: ManagedResourceId) =>
      resourceById(id, "reveal").pipe(
        Effect.flatMap((resource) => {
          const expected = targetFor(root, resource.kind, resource.id)
          return resource.managedPath === expected && inside(root, expected)
            ? Effect.succeed(expected)
            : Effect.fail(serviceError("reveal", "Managed resource path failed confinement validation"))
        })
      )

    const remove = (id: ManagedResourceId): Effect.Effect<void, AgentResourceError> =>
      reveal(id).pipe(
        Effect.flatMap((target) => Effect.tryPromise({
          try: async () => {
            const moved: { removal?: string; trash?: string } = {}
            try {
              await catalog.update(async (current) => {
                const resource = current.find((item) => item.id === id)
                if (resource === undefined) throw new Error("Managed resource does not exist")
                const removal = resource.kind === "skill" ? dirname(target) : target
                if (!inside(root, removal)) throw new Error("Managed resource removal escapes its root")
                const trash = join(root, ".trash", `${id}.${randomUUID()}`)
                await mkdir(dirname(trash), { recursive: true })
                await rename(removal, trash)
                moved.removal = removal
                moved.trash = trash
                return current.filter((item) => item.id !== id)
              })
            } catch (error) {
              if (moved.trash !== undefined && moved.removal !== undefined) {
                await rename(moved.trash, moved.removal).catch(() => undefined)
              }
              throw error
            }
            if (moved.trash !== undefined) await rm(moved.trash, { recursive: true, force: true })
          },
          catch: () => serviceError("remove", `Could not remove managed resource "${id}"`)
        })),
        Effect.zipRight(list),
        Effect.tap(publish),
        Effect.asVoid
      )

    const setEnabled = (
      id: ManagedResourceId,
      enabled: boolean
    ): Effect.Effect<void, AgentResourceError> =>
      Effect.tryPromise({
        try: () => catalog.update((current) => {
          if (!current.some((resource) => resource.id === id)) throw new Error("Managed resource does not exist")
          return current.map((resource) => resource.id === id ? { ...resource, enabled } : resource)
        }),
        catch: () => serviceError("enable", `Could not update managed resource "${id}"`)
      }).pipe(
        Effect.zipRight(list),
        Effect.tap(publish),
        Effect.asVoid
      )

    return {
      list,
      importResources,
      remove,
      reveal,
      setEnabled,
      enabledForTarget: (targetId) => list.pipe(
        Effect.map((resources) => resources.filter((resource) =>
          resource.enabled && supportsTarget(resource.scope, targetId)
        ))
      ),
      watch: () => Stream.concat(Stream.fromEffect(list.pipe(Effect.orElseSucceed(() => []))), Stream.fromPubSub(changes))
    }
  })
