/** The frontmatter parser intentionally supports the small, data-only YAML
 * dialect memory pages need. Canonical output uses JSON-compatible YAML values,
 * making serialization deterministic without admitting YAML tags or aliases. */
import { Schema } from "effect"

export interface ParsedFrontmatter {
  readonly attributes: Readonly<Record<string, unknown>>
  readonly body: string
}

export class FrontmatterParseError extends Error {
  override readonly name = "FrontmatterParseError"

  constructor(message: string, readonly line?: number) {
    super(line === undefined ? message : `${message} (frontmatter line ${line})`)
  }
}

const FRONTMATTER_BOUNDARY = /^---[\t ]*$/
const FRONTMATTER_KEY = /^[A-Za-z0-9_.-]+$/
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])
const FrontmatterAttributes = Schema.Record({ key: Schema.String, value: Schema.Unknown })

const splitLines = (value: string): Array<string> => value.split(/\r?\n/)

const stripComment = (value: string): string => {
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!
    if (escaped) {
      escaped = false
      continue
    }
    if (character === "\\" && quote === '"') {
      escaped = true
      continue
    }
    if (character === '"' || character === "'") {
      quote = quote === character ? null : quote === null ? character : quote
      continue
    }
    if (character === "#" && quote === null && (index === 0 || /\s/.test(value[index - 1]!))) {
      return value.slice(0, index).trimEnd()
    }
  }
  return value
}

const parseQuotedString = (value: string, line: number): string => {
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value)
      if (typeof parsed !== "string") throw new Error("not a string")
      return parsed
    } catch {
      throw new FrontmatterParseError("invalid double-quoted string", line)
    }
  }
  if (!value.endsWith("'")) {
    throw new FrontmatterParseError("unterminated single-quoted string", line)
  }
  return value.slice(1, -1).replace(/''/g, "'")
}

const splitInline = (value: string): Array<string> => {
  const parts: Array<string> = []
  let start = 0
  let depth = 0
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!
    if (escaped) {
      escaped = false
      continue
    }
    if (character === "\\" && quote === '"') {
      escaped = true
      continue
    }
    if (character === '"' || character === "'") {
      quote = quote === character ? null : quote === null ? character : quote
      continue
    }
    if (quote !== null) continue
    if (character === "[" || character === "{") depth += 1
    if (character === "]" || character === "}") depth -= 1
    if (character === "," && depth === 0) {
      parts.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  parts.push(value.slice(start).trim())
  return parts
}

const findMappingColon = (value: string): number => {
  let quote: '"' | "'" | null = null
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!
    if (character === '"' || character === "'") {
      quote = quote === character ? null : quote === null ? character : quote
      continue
    }
    if (character === ":" && quote === null) return index
  }
  return -1
}

const parseKey = (rawValue: string, line: number): string => {
  const value = rawValue.trim()
  const key = value.startsWith('"') || value.startsWith("'")
    ? parseQuotedString(value, line)
    : value
  if (!FRONTMATTER_KEY.test(key) || UNSAFE_KEYS.has(key)) {
    throw new FrontmatterParseError(`invalid key "${key}"`, line)
  }
  return key
}

const assertUniqueKey = (
  record: Readonly<Record<string, unknown>>,
  key: string,
  line: number
): void => {
  if (Object.hasOwn(record, key)) {
    throw new FrontmatterParseError(`duplicate key "${key}"`, line)
  }
}

const parseScalar = (rawValue: string, line: number): unknown => {
  const value = stripComment(rawValue).trim()
  if (value === "") return ""
  if (value.startsWith('"') || value.startsWith("'")) return parseQuotedString(value, line)
  if (value === "null" || value === "~") return null
  if (value === "true") return true
  if (value === "false") return false
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value)
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim()
    return inner === "" ? [] : splitInline(inner).map((entry) => parseScalar(entry, line))
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    const inner = value.slice(1, -1).trim()
    if (inner === "") return {}
    const record: Record<string, unknown> = {}
    for (const entry of splitInline(inner)) {
      const colon = findMappingColon(entry)
      if (colon < 1) throw new FrontmatterParseError("invalid inline mapping", line)
      const key = parseKey(entry.slice(0, colon), line)
      assertUniqueKey(record, key, line)
      record[key] = parseScalar(entry.slice(colon + 1), line)
    }
    return record
  }
  if (value.startsWith("!") || value.startsWith("&") || value.startsWith("*")) {
    throw new FrontmatterParseError("YAML tags and aliases are not supported", line)
  }
  return value
}

const indentationOf = (line: string): number => line.length - line.trimStart().length

interface ParsedBlock {
  readonly value: unknown
  readonly next: number
}

const parseArrayBlock = (
  lines: ReadonlyArray<string>,
  start: number,
  indent: number
): ParsedBlock => {
  const value: Array<unknown> = []
  let index = start
  while (index < lines.length) {
    const rawLine = lines[index]!
    if (rawLine.trim() === "" || rawLine.trimStart().startsWith("#")) {
      index += 1
      continue
    }
    const currentIndent = indentationOf(rawLine)
    if (currentIndent < indent) break
    if (currentIndent > indent) {
      throw new FrontmatterParseError("unexpected indentation", index + 1)
    }
    const line = rawLine.slice(indent)
    if (!(line === "-" || line.startsWith("- "))) break
    const item = line.slice(1).trim()
    if (item === "") {
      const nestedStart = index + 1
      if (nestedStart >= lines.length || indentationOf(lines[nestedStart]!) <= indent) {
        value.push(null)
        index += 1
      } else {
        const nested = parseBlock(lines, nestedStart, indentationOf(lines[nestedStart]!))
        value.push(nested.value)
        index = nested.next
      }
      continue
    }
    const colon = findMappingColon(item)
    if (colon < 1) {
      value.push(parseScalar(item, index + 1))
      index += 1
      continue
    }

    const record: Record<string, unknown> = {}
    const key = parseKey(item.slice(0, colon), index + 1)
    assertUniqueKey(record, key, index + 1)
    const rest = item.slice(colon + 1).trim()
    record[key] = rest === "" ? "" : parseScalar(rest, index + 1)
    index += 1
    while (index < lines.length) {
      const continuation = lines[index]!
      if (continuation.trim() === "") {
        index += 1
        continue
      }
      const continuationIndent = indentationOf(continuation)
      if (continuationIndent <= indent) break
      const continuationLine = continuation.trim()
      const continuationColon = findMappingColon(continuationLine)
      if (continuationColon < 1) {
        throw new FrontmatterParseError("invalid sequence mapping", index + 1)
      }
      const continuationKey = parseKey(
        continuationLine.slice(0, continuationColon),
        index + 1
      )
      assertUniqueKey(record, continuationKey, index + 1)
      const continuationRest = continuationLine.slice(continuationColon + 1).trim()
      if (continuationRest !== "") {
        record[continuationKey] = parseScalar(continuationRest, index + 1)
        index += 1
        continue
      }
      const nestedStart = index + 1
      if (nestedStart < lines.length && indentationOf(lines[nestedStart]!) > continuationIndent) {
        const nested = parseBlock(lines, nestedStart, indentationOf(lines[nestedStart]!))
        record[continuationKey] = nested.value
        index = nested.next
      } else {
        record[continuationKey] = ""
        index += 1
      }
    }
    value.push(record)
  }
  return { value, next: index }
}

const parseRecordBlock = (
  lines: ReadonlyArray<string>,
  start: number,
  indent: number
): ParsedBlock => {
  const value: Record<string, unknown> = {}
  let index = start
  while (index < lines.length) {
    const rawLine = lines[index]!
    if (rawLine.trim() === "" || rawLine.trimStart().startsWith("#")) {
      index += 1
      continue
    }
    const currentIndent = indentationOf(rawLine)
    if (currentIndent < indent) break
    if (currentIndent > indent) {
      throw new FrontmatterParseError("unexpected indentation", index + 1)
    }
    const line = rawLine.slice(indent)
    if (line.startsWith("- ")) break
    const colon = findMappingColon(line)
    if (colon < 1) throw new FrontmatterParseError("expected a key/value pair", index + 1)
    const key = parseKey(line.slice(0, colon), index + 1)
    assertUniqueKey(value, key, index + 1)
    const rest = line.slice(colon + 1).trim()
    if (rest !== "") {
      value[key] = parseScalar(rest, index + 1)
      index += 1
      continue
    }
    const nestedStart = index + 1
    if (nestedStart < lines.length && indentationOf(lines[nestedStart]!) > indent) {
      const nested = parseBlock(lines, nestedStart, indentationOf(lines[nestedStart]!))
      value[key] = nested.value
      index = nested.next
    } else {
      value[key] = ""
      index += 1
    }
  }
  return { value, next: index }
}

const parseBlock = (
  lines: ReadonlyArray<string>,
  start: number,
  indent: number
): ParsedBlock => {
  let firstContent = start
  while (
    firstContent < lines.length &&
    (lines[firstContent]!.trim() === "" || lines[firstContent]!.trimStart().startsWith("#"))
  ) {
    firstContent += 1
  }
  const first = lines[firstContent]
  if (first === undefined) return { value: {}, next: firstContent }
  return first.slice(indent).startsWith("-")
    ? parseArrayBlock(lines, start, indent)
    : parseRecordBlock(lines, start, indent)
}

/** Parse an optional `---` frontmatter block, preserving the body verbatim. */
export const parseFrontmatter = (markdown: string): ParsedFrontmatter => {
  const source = markdown.startsWith("\uFEFF") ? markdown.slice(1) : markdown
  const openingEnd = source.indexOf("\n")
  const openingLine = source
    .slice(0, openingEnd < 0 ? source.length : openingEnd)
    .replace(/\r$/, "")
  if (!FRONTMATTER_BOUNDARY.test(openingLine)) {
    return { attributes: {}, body: source }
  }
  let lineStart = openingEnd + 1
  let frontmatterEnd = -1
  let bodyStart = -1
  while (lineStart > 0 && lineStart <= source.length) {
    const newline = source.indexOf("\n", lineStart)
    const lineEnd = newline < 0 ? source.length : newline
    const line = source.slice(lineStart, lineEnd).replace(/\r$/, "")
    if (FRONTMATTER_BOUNDARY.test(line)) {
      frontmatterEnd = lineStart
      bodyStart = newline < 0 ? source.length : newline + 1
      break
    }
    if (newline < 0) break
    lineStart = newline + 1
  }
  if (frontmatterEnd < 0) throw new FrontmatterParseError("frontmatter has no closing delimiter")
  const frontmatterLines = splitLines(source.slice(openingEnd + 1, frontmatterEnd))
  const parsed = parseBlock(frontmatterLines, 0, 0).value
  const attributes = Schema.decodeUnknownOption(FrontmatterAttributes)(parsed)
  if (attributes._tag === "None") {
    throw new FrontmatterParseError("frontmatter must be a mapping")
  }
  return {
    attributes: attributes.value,
    body: source.slice(bodyStart)
  }
}

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue)
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)])
    )
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value
  }
  if (typeof value === "number" && Number.isFinite(value)) return value
  throw new TypeError(`frontmatter cannot serialize ${typeof value}`)
}

/** Deterministic JSON-compatible YAML. Object keys are sorted recursively. */
export const serializeFrontmatter = (
  attributes: Readonly<Record<string, unknown>>,
  body: string
): string => {
  const lines = Object.entries(attributes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      if (!FRONTMATTER_KEY.test(key) || UNSAFE_KEYS.has(key)) {
        throw new TypeError(`frontmatter cannot serialize key "${key}"`)
      }
      return `${key}: ${JSON.stringify(stableValue(value))}`
    })
  return `---\n${lines.join("\n")}\n---\n${body}`
}

export const stringifyFrontmatter = serializeFrontmatter
