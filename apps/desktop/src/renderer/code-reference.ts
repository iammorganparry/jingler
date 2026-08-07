/**
 * A source excerpt captured from a repository file for the next composer turn.
 *
 * Lines are one-based and inclusive. `source` is the captured text, not a live
 * file lookup: sending must preserve exactly what the operator selected even if
 * the worktree changes before they press Enter.
 */
export interface CodeReference {
  readonly path: string
  readonly startLine: number
  readonly endLine: number
  readonly source: string
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:\//
const AMBIGUOUS_PATH_CHARACTERS = /\r|\n|\0/
const BACKTICK_RUN = /`+/g
const SOURCE_LINE = /[^\r\n]*(?:\r\n|\r|\n|$)/g

/**
 * Make a path repository-relative without interpreting punctuation as syntax.
 * Escapes above the repository root and absolute paths are rejected.
 */
const normalizeRepositoryPath = (value: string): string | null => {
  const path = value.trim().replaceAll("\\", "/")
  if (path === "" || path.startsWith("/") || WINDOWS_ABSOLUTE_PATH.test(path)) return null
  // Newlines would make the prompt's path header ambiguous. Other punctuation,
  // including spaces, colons, brackets and `@`, is ordinary filename content.
  if (AMBIGUOUS_PATH_CHARACTERS.test(path)) return null

  const segments: string[] = []
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      if (segments.length === 0) return null
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.length > 0 ? segments.join("/") : null
}

/** Validate and canonicalise a persisted or newly captured code reference. */
export const normalizeCodeReference = (value: unknown): CodeReference | null => {
  const record = asRecord(value)
  if (record === null) return null
  if (
    typeof record.path !== "string" ||
    typeof record.startLine !== "number" ||
    typeof record.endLine !== "number" ||
    typeof record.source !== "string" ||
    !Number.isInteger(record.startLine) ||
    !Number.isInteger(record.endLine) ||
    record.startLine < 1 ||
    record.endLine < 1
  ) {
    return null
  }

  const path = normalizeRepositoryPath(record.path)
  if (path === null) return null
  return {
    path,
    startLine: Math.min(record.startLine, record.endLine),
    endLine: Math.max(record.startLine, record.endLine),
    // Do not trim or normalise line endings: this is the captured source.
    source: record.source,
  }
}

/** Capture an inclusive one-based range from the current editor buffer verbatim. */
export const captureCodeReference = (
  path: string,
  text: string,
  startLine: number,
  endLine: number
): CodeReference | null => {
  const start = Math.min(startLine, endLine)
  const end = Math.max(startLine, endLine)
  const lines = [...text.matchAll(SOURCE_LINE)]
    .map((match) => match[0])
    .filter((line, index, all) => !(index === all.length - 1 && line === ""))
  if (start < 1 || end > lines.length) return null
  return normalizeCodeReference({
    path,
    startLine: start,
    endLine: end,
    source: lines.slice(start - 1, end).join("")
  })
}

/** Location identity for deduplication; source is payload, not identity. */
export const codeReferenceKey = (
  reference: Pick<CodeReference, "path" | "startLine" | "endLine">
): string => JSON.stringify([reference.path, reference.startLine, reference.endLine])

/**
 * Normalise and discard invalid entries. A range keeps its first position but
 * its newest capture, so re-selecting edited code updates the payload sent to
 * the agent without making the chip jump in the composer.
 */
export const deduplicateCodeReferences = (
  references: ReadonlyArray<unknown>
): ReadonlyArray<CodeReference> => {
  const positions = new Map<string, number>()
  const result: CodeReference[] = []
  for (const value of references) {
    const reference = normalizeCodeReference(value)
    if (reference === null) continue
    const key = codeReferenceKey(reference)
    const existing = positions.get(key)
    if (existing === undefined) {
      positions.set(key, result.length)
      result.push(reference)
    } else {
      result[existing] = reference
    }
  }
  return result
}

/** Compact one-based inclusive range text for a chip. */
export const codeReferenceRangeLabel = (
  reference: Pick<CodeReference, "startLine" | "endLine">
): string =>
  reference.startLine === reference.endLine
    ? `L${reference.startLine}`
    : `L${reference.startLine}\u2013L${reference.endLine}`

/** Full repository location shown by range-aware composer chips. */
export const codeReferenceDisplayLabel = (
  reference: Pick<CodeReference, "path" | "startLine" | "endLine">
): string => `${reference.path}:${codeReferenceRangeLabel(reference)}`

const fenceFor = (source: string): string => {
  let longest = 0
  for (const match of source.matchAll(BACKTICK_RUN)) longest = Math.max(longest, match[0].length)
  return "`".repeat(Math.max(3, longest + 1))
}

/**
 * Serialize captured ranges into a deterministic, harness-agnostic context block.
 * The fence has no language annotation and grows around backticks in the source.
 */
export const serializeCodeReferences = (references: ReadonlyArray<unknown>): string => {
  const normalized = deduplicateCodeReferences(references)
  if (normalized.length === 0) return ""

  const blocks = normalized.map((reference, index) => {
    const fence = fenceFor(reference.source)
    const lines =
      reference.startLine === reference.endLine
        ? `${reference.startLine} (inclusive)`
        : `${reference.startLine}-${reference.endLine} (inclusive)`
    const fencedSource = `${fence}\n${reference.source}${reference.source.endsWith("\n") ? "" : "\n"}${fence}`
    return [
      `Reference ${index + 1}`,
      `Path: ${JSON.stringify(reference.path)}`,
      `Lines: ${lines}`,
      "Source:",
      fencedSource
    ].join("\n")
  })

  return [
    "<repository-code-references>",
    "Captured repository excerpts. Line ranges are one-based and inclusive.",
    blocks.join("\n\n"),
    "</repository-code-references>"
  ].join("\n")
}

/** Append reference context without rewriting the operator's visible message. */
export const appendCodeReferencesToPrompt = (
  prompt: string,
  references: ReadonlyArray<unknown>
): string => {
  const context = serializeCodeReferences(references)
  if (context === "") return prompt
  return prompt === "" ? context : `${prompt}\n\n${context}`
}
