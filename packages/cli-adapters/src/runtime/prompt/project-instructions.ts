import { constants, type Dirent, type Stats } from "node:fs"
import { lstat, open, readdir, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join, relative } from "node:path"
import { promptLayer } from "./role-profiles.js"
import type { PromptLayer } from "./prompt-compiler.js"

const FILES = ["AGENTS.md", "CLAUDE.md"] as const
const MAX_FILE_BYTES = 32 * 1024
const MAX_RULE_FILES = 64
/** Directory entries visited per rules tree, so a wide tree can't stall session start. */
const MAX_RULE_ENTRIES = 1_000
const MAX_RULE_DEPTH = 4

const sameFile = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino

const decodeUtf8Prefix = (buffer: Buffer): string => {
  if (buffer.length === 0) return ""
  let start = buffer.length - 1
  while (start > 0 && (buffer[start]! & 0xc0) === 0x80) start--
  const lead = buffer[start]!
  const width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4
  const end = buffer.length - start < width ? start : buffer.length
  return buffer.subarray(0, end).toString("utf8")
}

const readBoundedFile = async (
  path: string,
  name: string,
  limit: number
): Promise<string | null> => {
  const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null
    throw error
  })
  if (before === null || !before.isFile()) return null
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW || 0)
  ).catch((error: NodeJS.ErrnoException) => {
    if (["EISDIR", "ELOOP", "ENOENT", "ENXIO"].includes(error.code ?? "")) return null
    throw error
  })
  if (file === null) return null
  try {
    const opened = await file.stat()
    const after = await lstat(path).catch(() => null)
    if (
      !opened.isFile() ||
      after === null ||
      !after.isFile() ||
      !sameFile(before, opened) ||
      !sameFile(opened, after)
    ) return null
    const buffer = Buffer.alloc(limit + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    const truncated = bytesRead > limit
    const content = decodeUtf8Prefix(buffer.subarray(0, Math.min(bytesRead, limit))).trim()
    return truncated
      ? `${content}\n\n[TRUNCATED: ${name} exceeds ${limit} bytes]`
      : content
  } finally {
    await file.close()
  }
}

const isRealDirectory = async (path: string): Promise<boolean> =>
  (await lstat(path).catch(() => null))?.isDirectory() === true

interface Walk {
  entries: number
  readonly files: Array<string>
  readonly visited: Set<string>
  truncated: boolean
}

/**
 * `*.md` under a Claude Code rules directory, sorted for a stable prompt.
 * Repo-controlled rules never follow symlinks (a checkout could point one at a
 * secret); the operator's own `~/.claude/rules` does, like Claude Code itself.
 */
const walkRules = async (dir: string, followLinks: boolean, walk: Walk, depth = 0): Promise<void> => {
  const canonical = await realpath(dir).catch(() => null)
  if (canonical === null || walk.visited.has(canonical)) return
  walk.visited.add(canonical)
  if (depth > MAX_RULE_DEPTH) {
    walk.truncated = true
    return
  }
  const entries: Array<Dirent> = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (walk.files.length >= MAX_RULE_FILES || ++walk.entries > MAX_RULE_ENTRIES) {
      walk.truncated = true
      return
    }
    await visitEntry(dir, entry, followLinks, walk, depth)
  }
}

const visitEntry = async (dir: string, entry: Dirent, followLinks: boolean, walk: Walk, depth: number): Promise<void> => {
  const path = join(dir, entry.name)
  if (entry.isSymbolicLink() && !followLinks) return
  const kind: Dirent | Stats | null = entry.isSymbolicLink() ? await stat(path).catch(() => null) : entry
  if (kind?.isDirectory()) await walkRules(path, followLinks, walk, depth + 1)
  else if (kind?.isFile() && entry.name.endsWith(".md")) walk.files.push(path)
}

const ruleFiles = async (dir: string, followLinks: boolean): Promise<Walk> => {
  const walk: Walk = { entries: 0, files: [], visited: new Set(), truncated: false }
  await walkRules(dir, followLinks, walk)
  return walk
}

interface InstructionFile {
  readonly label: string
  readonly path: string
  readonly followLinks: boolean
}

/** Claude rules may carry `paths:` frontmatter; keep that scope visible instead of applying the rule everywhere. */
export const ruleScope = (content: string): string | null => {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content)?.[1]
  if (frontmatter === undefined) return null
  const lines = frontmatter.split(/\r?\n/u)
  const start = lines.findIndex((line) => /^paths\s*:/u.test(line))
  if (start < 0) return null
  const inline = lines[start]!.replace(/^paths\s*:/u, "").trim()
  const listed = lines.slice(start + 1)
    .filter((line, index, rest) => rest.slice(0, index + 1).every((item) => /^\s*-/u.test(item)))
    .map((line) => line.replace(/^\s*-\s*/u, "").trim())
  const globs = [inline, ...listed].join(",").split(",").map((glob) => glob.trim().replace(/^["']|["']$/gu, "")).filter(Boolean)
  return globs.length === 0 ? null : globs.join(", ")
}

interface Loaded {
  readonly sections: ReadonlyArray<string>
  readonly labels: ReadonlyArray<string>
  readonly skipped: ReadonlyArray<string>
}

const loadFiles = async (files: ReadonlyArray<InstructionFile>): Promise<Loaded> => {
  const results = await Promise.all(files.map(async ({ label, path, followLinks }) => {
    try {
      const target = followLinks ? await realpath(path).catch(() => null) : path
      const content = target === null ? null : await readBoundedFile(target, label, MAX_FILE_BYTES)
      return content ? { label, content } : null
    } catch {
      // One unreadable optional file must not block the session.
      return { label, content: null }
    }
  }))
  const loaded = results.flatMap((result) => result?.content ? [{ label: result.label, content: result.content }] : [])
  return {
    labels: loaded.map(({ label }) => label),
    skipped: results.flatMap((result) => result !== null && result.content === null ? [result.label] : []),
    sections: loaded.map(({ label, content }) => {
      const scope = ruleScope(content)
      return scope === null
        ? `## ${label}\n${content}`
        : `## ${label}\nScoped rule: apply only when working on files matching ${scope}.\n${content}`
    })
  }
}

const instructionLayer = (
  id: string,
  intro: string,
  loaded: Loaded,
  truncatedDirs: ReadonlyArray<string>
): PromptLayer | null =>
  loaded.sections.length === 0 && loaded.skipped.length === 0 && truncatedDirs.length === 0
    ? null
    : promptLayer("workspace", id, [
        intro,
        // Listed up front; a trailing [TRUNCATED] marker means the prompt budget cut the last files.
        `Files: ${loaded.labels.join(", ") || "none"}`,
        ...(loaded.skipped.length === 0 ? [] : [`Unreadable, skipped: ${loaded.skipped.join(", ")}`]),
        ...truncatedDirs.map((dir) => `Rules under ${dir} exceeded ${MAX_RULE_FILES} files, ${MAX_RULE_DEPTH} levels or ${MAX_RULE_ENTRIES} entries; the rest were not loaded.`),
        ...loaded.sections
      ].join("\n\n"))

/**
 * The instruction files a native Claude Code session would load. Jingler runs
 * harnesses with their own setting sources off, so these layers are the only
 * way they reach the agent.
 *
 * Project instructions come first and user instructions are a separate layer
 * after them: the compiler fills layers in order, so an oversized user
 * `~/.claude` truncates itself rather than the repository's instructions.
 */
export const instructionLayers = async (
  cwd: string,
  home: string = homedir()
): Promise<ReadonlyArray<PromptLayer>> => {
  const root = await realpath(cwd)
  const userRulesDir = join(home, ".claude", "rules")
  const projectRulesDir = join(root, ".claude", "rules")
  const projectRulesExist = await isRealDirectory(join(root, ".claude")) && await isRealDirectory(projectRulesDir)
  const [userRules, projectRules] = await Promise.all([
    ruleFiles(userRulesDir, true),
    projectRulesExist ? ruleFiles(projectRulesDir, false) : Promise.resolve(null)
  ])
  const [project, user] = await Promise.all([
    loadFiles([
      ...FILES.map((name) => ({ label: name, path: join(root, name), followLinks: false })),
      ...(projectRules?.files ?? []).map((path) => ({ label: relative(root, path), path, followLinks: false }))
    ]),
    loadFiles([
      { label: "~/.claude/CLAUDE.md", path: join(home, ".claude", "CLAUDE.md"), followLinks: true },
      ...userRules.files.map((path) => ({
        label: `~/.claude/rules/${relative(userRulesDir, path)}`, path, followLinks: true
      }))
    ])
  ])
  return [
    instructionLayer(
      "workspace.project-instructions",
      "Follow these workspace-root project instructions unless they conflict with higher-priority Jingler or operator instructions.",
      project,
      projectRules?.truncated ? [".claude/rules"] : []
    ),
    instructionLayer(
      "workspace.user-instructions",
      "Follow these user-level instructions unless they conflict with higher-priority Jingler, operator or project instructions.",
      user,
      userRules.truncated ? ["~/.claude/rules"] : []
    )
  ].flatMap((layer) => layer === null ? [] : [layer])
}
