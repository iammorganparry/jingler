import { randomUUID } from "node:crypto"
import { FileSystem, Path } from "@effect/platform"
import type { ExplanationDocument, ObsidianExplanationsConfig } from "@jingler/core"
import { explanationToMarkdown } from "@jingler/core"
import { Effect } from "effect"

const CREATED_AT = /^createdAt: "([^"\n]*)"$/m
const unsafeSegment = (segment: string): boolean => segment.startsWith(".") || /[:\0]/u.test(segment)

/** Stable per explanation id, so re-publishing overwrites instead of duplicating. */
export const obsidianExplanationFileName = (explanationId: string): string =>
  `explanation-${explanationId}.md`

/**
 * Write (or overwrite) the explanation's note inside the session's vault folder.
 * Returns the vault-relative path, or null when the setting is off (nothing written).
 */
export const saveExplanationToObsidian = (input: {
  readonly config: ObsidianExplanationsConfig
  readonly vaultRoot: string
  readonly document: ExplanationDocument
  readonly sessionTitle: string
  readonly project: string
  readonly branch: string
}): Effect.Effect<string | null, Error, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    if (!input.config.enabled) return null
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const segments = input.config.folder.split(/[\\/]/u).filter((segment) => segment.length > 0)
    if (segments.some(unsafeSegment)) {
      return yield* Effect.fail(new Error("The Obsidian folder must be a plain relative path inside the vault."))
    }
    const root = yield* fs.realPath(input.vaultRoot)
    const dir = path.join(root, ...segments)
    yield* fs.makeDirectory(dir, { recursive: true })
    const realDir = yield* fs.realPath(dir)
    if (realDir !== root && !realDir.startsWith(root + path.sep)) {
      return yield* Effect.fail(new Error("The Obsidian folder escapes the vault."))
    }
    const name = obsidianExplanationFileName(input.document.id)
    const file = path.join(realDir, name)
    const previous = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
    const markdown = explanationToMarkdown(input.document, {
      session: input.sessionTitle,
      project: input.project,
      branch: input.branch,
      createdAt: CREATED_AT.exec(previous)?.[1] ?? input.document.updatedAt
    })
    // Dot-prefixed so Obsidian never indexes the half-written temp file.
    const temp = path.join(realDir, `.${name}.${randomUUID()}.tmp`)
    yield* fs.writeFileString(temp, markdown)
    yield* fs.rename(temp, file).pipe(Effect.tapError(() => fs.remove(temp).pipe(Effect.ignore)))
    return [...segments, name].join("/")
  }).pipe(Effect.mapError((cause) => cause instanceof Error ? cause : new Error(String(cause))))
