import {
  parseDiffFromFile,
  parsePatchFiles,
  trimPatchContext,
  type CodeViewDiffItem,
  type CodeViewFileItem,
  type CodeViewItem,
  type DiffLineAnnotation,
  type FileContents,
  type FileDiffMetadata,
  type LineAnnotation,
  type SupportedLanguages
} from "@pierre/diffs"
import type { GitStatus, GitStatusEntry } from "@pierre/trees"

export type JinglerFileStatus =
  | "clean"
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "ignored"

export interface JinglerFileSnapshot {
  readonly path: string
  readonly contents: string
  readonly language?: SupportedLanguages
  /** A Git object id, file mtime, query revision, or other caller-owned identity. */
  readonly revision?: string | number
}

export interface JinglerFileChange {
  readonly status: Exclude<JinglerFileStatus, "clean" | "ignored">
  readonly path: string
  readonly previousPath?: string
  readonly before?: string
  readonly after?: string
  readonly language?: SupportedLanguages
  readonly beforeRevision?: string | number
  readonly afterRevision?: string | number
}

const hashParts = (parts: readonly string[]): number => {
  let hash = 0x811c9dc5
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      hash ^= part.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193)
    }
    hash ^= 0
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Canonical repo path used for Pierre item, selection, tree, and status identity. */
export const canonicalPierrePath = (input: string): string => {
  const slashed = input.replaceAll("\\", "/")
  const directory = slashed.endsWith("/")
  const segments = slashed
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")

  if (segments.some((segment) => segment === "..")) {
    throw new Error(`Pierre paths must be repo-relative: ${input}`)
  }

  const path = segments.join("/")
  if (path.length === 0) throw new Error("Pierre paths cannot be empty")
  return directory ? `${path}/` : path
}

/** Content-derived worker cache key. It changes whenever any supplied part changes. */
export const pierreCacheKey = (
  kind: "file" | "diff" | "patch",
  ...parts: readonly (string | number | undefined)[]
): string => {
  const normalized = parts.map((part) => (part === undefined ? "" : String(part)))
  return `jingler:${kind}:${hashParts(normalized).toString(36)}`
}

/** Numeric revision for CodeView's cheap item reconciliation. */
export const pierreItemVersion = (
  ...parts: readonly (string | number | undefined)[]
): number => hashParts(parts.map((part) => (part === undefined ? "" : String(part))))

export const createPierreFileContents = ({
  path: inputPath,
  contents,
  language,
  revision
}: JinglerFileSnapshot): FileContents => {
  const path = canonicalPierrePath(inputPath)
  return {
    name: path,
    contents,
    ...(language === undefined ? {} : { lang: language }),
    cacheKey: pierreCacheKey("file", path, language, revision, contents)
  }
}

const linesOf = (contents: string): string[] => {
  if (contents.length === 0) return []
  const lines = contents.replaceAll("\r\n", "\n").split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}

const changeType = (
  change: JinglerFileChange,
  before: string,
  after: string
): FileDiffMetadata["type"] => {
  switch (change.status) {
    case "modified":
      return "change"
    case "added":
    case "untracked":
      return "new"
    case "deleted":
      return "deleted"
    case "renamed":
      return before === after ? "rename-pure" : "rename-changed"
  }
}

interface NormalizedPierreChange {
  readonly path: string
  readonly previousPath?: string
  readonly before: string
  readonly after: string
  readonly oldName: string
  readonly newName: string
}

const normalizeChange = (change: JinglerFileChange): NormalizedPierreChange => {
  const path = canonicalPierrePath(change.path)
  const previousPath = change.previousPath === undefined
    ? undefined
    : canonicalPierrePath(change.previousPath)

  if (change.status === "renamed" && previousPath === undefined) {
    throw new Error("Renamed Pierre files require previousPath")
  }

  const noPreviousContents = change.status === "added" || change.status === "untracked"
  const before = noPreviousContents ? "" : (change.before ?? "")
  const after = change.status === "deleted" ? "" : (change.after ?? "")
  return {
    path,
    ...(previousPath === undefined ? {} : { previousPath }),
    before,
    after,
    oldName: noPreviousContents ? "/dev/null" : (previousPath ?? path),
    newName: change.status === "deleted" ? "/dev/null" : path
  }
}

interface EmptyDiffOptions {
  readonly change: JinglerFileChange
  readonly normalized: NormalizedPierreChange
  readonly cacheKey: string
}

const emptyDiff = ({
  change,
  normalized,
  cacheKey
}: EmptyDiffOptions): FileDiffMetadata => ({
  name: normalized.path,
  ...(normalized.previousPath === undefined
    ? {}
    : { prevName: normalized.previousPath }),
  ...(change.language === undefined ? {} : { lang: change.language }),
  type: changeType(change, normalized.before, normalized.after),
  hunks: [],
  splitLineCount: 0,
  unifiedLineCount: 0,
  isPartial: false,
  deletionLines: linesOf(normalized.before),
  additionLines: linesOf(normalized.after),
  cacheKey
})

/**
 * Build full-file Pierre metadata for modified, added, deleted, renamed, and
 * empty changes. Clean files intentionally use createPierreFileContents + File.
 */
export const createPierreFileDiff = (change: JinglerFileChange): FileDiffMetadata => {
  const normalized = normalizeChange(change)
  const oldFile = createPierreFileContents({
    path: normalized.oldName === "/dev/null" ? "dev/null" : normalized.oldName,
    contents: normalized.before,
    language: change.language,
    revision: change.beforeRevision
  })
  const newFile = createPierreFileContents({
    path: normalized.newName === "/dev/null" ? "dev/null" : normalized.newName,
    contents: normalized.after,
    language: change.language,
    revision: change.afterRevision
  })
  oldFile.name = normalized.oldName
  newFile.name = normalized.newName

  const cacheKey = pierreCacheKey(
    "diff",
    change.status,
    normalized.previousPath,
    normalized.path,
    change.beforeRevision,
    change.afterRevision,
    normalized.before,
    normalized.after
  )

  if (normalized.before === normalized.after) {
    return emptyDiff({ change, normalized, cacheKey })
  }

  const parsed = parseDiffFromFile(oldFile, newFile, undefined, true)
  return {
    ...parsed,
    name: normalized.path,
    ...(normalized.previousPath === undefined
      ? {}
      : { prevName: normalized.previousPath }),
    ...(change.language === undefined ? {} : { lang: change.language }),
    type: changeType(change, normalized.before, normalized.after),
    cacheKey
  }
}

const patchFiles = (patch: string): FileDiffMetadata[] => {
  const cachePrefix = pierreCacheKey("patch", patch)
  return parsePatchFiles(patch, cachePrefix, true).flatMap((parsed) => parsed.files)
}

/** Parse exactly one file from a unified or Git patch. */
export const createPierreFileDiffFromPatch = (patch: string): FileDiffMetadata => {
  const files = patchFiles(patch)
  if (files.length !== 1) {
    throw new Error(`Expected a single-file patch, received ${files.length} files`)
  }
  return files[0]!
}

/** Trim excess context while keeping valid hunk boundaries and line numbers. */
export const createPierrePartialFileDiff = (
  patch: string,
  contextLines = 3
): FileDiffMetadata => {
  if (!Number.isInteger(contextLines) || contextLines < 0) {
    throw new Error("Pierre partial hunk context must be a non-negative integer")
  }
  return createPierreFileDiffFromPatch(trimPatchContext(patch, contextLines))
}

export const jinglerStatusFromPierreDiff = (
  fileDiff: FileDiffMetadata
): Exclude<JinglerFileStatus, "clean" | "ignored" | "untracked"> => {
  switch (fileDiff.type) {
    case "new":
      return "added"
    case "deleted":
      return "deleted"
    case "rename-pure":
    case "rename-changed":
      return "renamed"
    case "change":
      return "modified"
  }
}

export const pierreGitStatus = (status: JinglerFileStatus): GitStatus | undefined => {
  switch (status) {
    case "clean":
      return
    case "added":
      return "added"
    case "deleted":
      return "deleted"
    case "ignored":
      return "ignored"
    case "modified":
      return "modified"
    case "renamed":
      return "renamed"
    case "untracked":
      return "untracked"
  }
}

export const createPierreGitStatusEntries = (
  entries: ReadonlyArray<{ readonly path: string; readonly status: JinglerFileStatus }>
): GitStatusEntry[] =>
  entries.flatMap(({ path, status }) => {
    const mapped = pierreGitStatus(status)
    return mapped === undefined
      ? []
      : [{ path: canonicalPierrePath(path), status: mapped }]
  })

export type PierreCodeViewInput<TAnnotation = undefined> =
  | {
      readonly type: "file"
      readonly file: FileContents
      readonly id?: string
      readonly annotations?: LineAnnotation<TAnnotation>[]
      readonly version?: number
      readonly collapsed?: boolean
    }
  | {
      readonly type: "diff"
      readonly fileDiff: FileDiffMetadata
      readonly id?: string
      readonly annotations?: DiffLineAnnotation<TAnnotation>[]
      readonly version?: number
      readonly collapsed?: boolean
    }

export const createPierreCodeViewItem = <TAnnotation,>(
  input: PierreCodeViewInput<TAnnotation>
): CodeViewItem<TAnnotation> => {
  if (input.type === "file") {
    const item: CodeViewFileItem<TAnnotation> = {
      id: input.id ?? canonicalPierrePath(input.file.name),
      type: "file",
      file: input.file,
      ...(input.annotations === undefined ? {} : { annotations: input.annotations }),
      ...(input.collapsed === undefined ? {} : { collapsed: input.collapsed }),
      version:
        input.version ??
        pierreItemVersion(input.file.cacheKey, input.file.name, input.file.contents)
    }
    return item
  }

  const item: CodeViewDiffItem<TAnnotation> = {
    id: input.id ?? canonicalPierrePath(input.fileDiff.name),
    type: "diff",
    fileDiff: input.fileDiff,
    ...(input.annotations === undefined ? {} : { annotations: input.annotations }),
    ...(input.collapsed === undefined ? {} : { collapsed: input.collapsed }),
    version:
      input.version ??
      pierreItemVersion(
        input.fileDiff.cacheKey,
        input.fileDiff.prevName,
        input.fileDiff.name,
        input.fileDiff.type
      )
  }
  return item
}

export const createPierreCodeViewItems = <TAnnotation,>(
  inputs: readonly PierreCodeViewInput<TAnnotation>[]
): CodeViewItem<TAnnotation>[] => inputs.map(createPierreCodeViewItem)

/** Parse a multi-file patch directly into CodeView's controlled item model. */
export const createPierreCodeViewItemsFromPatch = (
  patch: string
): CodeViewItem[] =>
  patchFiles(patch).map((fileDiff) =>
    createPierreCodeViewItem({ type: "diff", fileDiff })
  )
