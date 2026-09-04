import { readFile, readdir, realpath, stat } from "node:fs/promises"
import { basename, isAbsolute, join, relative } from "node:path"
import type {
  DetectedResourceCandidate,
  ManagedResourceKind,
  ManagedResourceOrigin,
  ResourceDetectionResult,
  ResourceImportDiagnostic
} from "@jingler/core"
import { ManagedResourceId } from "@jingler/core"
import { Effect, Schema } from "effect"
import { skillMetadataFromContent } from "./skill-metadata.js"

const MAX_RESOURCE_BYTES = 256 * 1024

interface DetectionRoot {
  readonly path: string
  readonly kind: Extract<ManagedResourceKind, "skill" | "prompt">
  readonly origin: ManagedResourceOrigin
}

export interface ResourceDetectionInput {
  readonly homeDir: string | null
  readonly worktreePath: string | null
}

const inside = (root: string, target: string): boolean => {
  const nested = relative(root, target)
  return nested === "" || (!nested.startsWith("..") && !isAbsolute(nested))
}

const resourceId = (value: string) =>
  Schema.decodeUnknownSync(ManagedResourceId)(
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/gu, "-")
      .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, "") || "resource"
  )

const diagnostic = (
  sourcePath: string,
  kind: ManagedResourceKind | null,
  code: ResourceImportDiagnostic["code"],
  message: string
): ResourceImportDiagnostic => ({ sourcePath, kind, code, message })

const rootsFor = (input: ResourceDetectionInput): ReadonlyArray<DetectionRoot> => [
  ...(input.homeDir === null ? [] : [
    { path: join(input.homeDir, ".claude", "skills"), kind: "skill" as const, origin: "claude" as const },
    { path: join(input.homeDir, ".codex", "skills"), kind: "skill" as const, origin: "codex" as const },
    { path: join(input.homeDir, ".agents", "skills"), kind: "skill" as const, origin: "shared" as const },
    { path: join(input.homeDir, ".pi", "agent", "skills"), kind: "skill" as const, origin: "pi" as const },
    { path: join(input.homeDir, ".claude", "commands"), kind: "prompt" as const, origin: "claude" as const },
    { path: join(input.homeDir, ".pi", "agent", "prompts"), kind: "prompt" as const, origin: "pi" as const }
  ]),
  ...(input.worktreePath === null ? [] : [
    { path: join(input.worktreePath, ".claude", "skills"), kind: "skill" as const, origin: "claude" as const },
    { path: join(input.worktreePath, ".codex", "skills"), kind: "skill" as const, origin: "codex" as const },
    { path: join(input.worktreePath, ".agents", "skills"), kind: "skill" as const, origin: "shared" as const },
    { path: join(input.worktreePath, ".pi", "agent", "skills"), kind: "skill" as const, origin: "pi" as const },
    { path: join(input.worktreePath, ".claude", "commands"), kind: "prompt" as const, origin: "claude" as const },
    { path: join(input.worktreePath, ".pi", "agent", "prompts"), kind: "prompt" as const, origin: "pi" as const }
  ])
]

const detectRoot = async (
  root: DetectionRoot
): Promise<ResourceDetectionResult> => {
  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(root.path)
  } catch {
    return { candidates: [], skipped: [] }
  }

  const candidates: DetectedResourceCandidate[] = []
  const skipped: ResourceImportDiagnostic[] = []
  const entries = await readdir(canonicalRoot, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".")) continue
    const source = join(canonicalRoot, entry.name)
    try {
      const resolvedEntry = await realpath(source)
      if (!inside(canonicalRoot, resolvedEntry)) {
        skipped.push(diagnostic(source, root.kind, "escaping-path", "Resource symlink escapes its detected root"))
        continue
      }
      const entryInfo = await stat(resolvedEntry)
      const isDirectory = entryInfo.isDirectory()
      const document = root.kind === "skill" && isDirectory
        ? join(resolvedEntry, "SKILL.md")
        : resolvedEntry
      if (root.kind === "prompt" && (isDirectory || !/\.md$/iu.test(entry.name))) continue
      if (root.kind === "skill" && !isDirectory && !/\.(md|skill)$/iu.test(entry.name)) continue
      const resolvedDocument = await realpath(document)
      if (!inside(canonicalRoot, resolvedDocument)) {
        skipped.push(diagnostic(document, root.kind, "escaping-path", "Resource document escapes its detected root"))
        continue
      }
      const info = await stat(resolvedDocument)
      if (!info.isFile()) continue
      if (info.size > MAX_RESOURCE_BYTES) {
        skipped.push(diagnostic(document, root.kind, "oversized", "Resource exceeds the 256 KiB import limit"))
        continue
      }
      const content = await readFile(resolvedDocument, "utf8")
      const metadata = root.kind === "skill"
        ? skillMetadataFromContent(content, entry.name)
        : { name: basename(entry.name, ".md"), description: "Prompt template" }
      candidates.push({
        id: resourceId(metadata.name),
        kind: root.kind,
        name: metadata.name,
        description: metadata.description,
        byteLength: info.size,
        provenance: {
          origin: root.origin,
          sourceRoot: canonicalRoot,
          sourcePath: resolvedDocument,
          importedAt: null
        }
      })
    } catch {
      skipped.push(diagnostic(source, root.kind, "malformed", "Resource could not be read"))
    }
  }
  return { candidates, skipped }
}

/** Detect metadata only. Nothing is copied, enabled, parsed for secrets, or executed. */
export const detectAgentResources = (
  input: ResourceDetectionInput
): Effect.Effect<ResourceDetectionResult> =>
  Effect.tryPromise(async () => {
    const detected = await Promise.all(rootsFor(input).map(detectRoot))
    return {
      candidates: detected.flatMap((result) => result.candidates),
      skipped: detected.flatMap((result) => result.skipped)
    }
  }).pipe(Effect.orElseSucceed(() => ({ candidates: [], skipped: [] })))
