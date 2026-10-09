import { constants, type Dirent, type Stats } from "node:fs"
import { lstat, open, readdir, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join, relative } from "node:path"
import { promptLayer } from "./role-profiles.js"
import type { PromptLayer } from "./prompt-compiler.js"

const FILES = ["AGENTS.md", "CLAUDE.md"] as const
const MAX_FILE_BYTES = 32 * 1024
const MAX_RULE_FILES = 64
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

/**
 * `*.md` under a Claude Code rules directory, sorted for a stable prompt.
 * Repo-controlled rules never follow symlinks (a checkout could point one at a
 * secret); the operator's own `~/.claude/rules` does, like Claude Code itself.
 */
const ruleFiles = async (dir: string, followLinks: boolean, depth = 0): Promise<ReadonlyArray<string>> => {
  if (depth > MAX_RULE_DEPTH) return []
  const entries: Array<Dirent> = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const files: Array<string> = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink() && !followLinks) continue
    const kind: Dirent | Stats | null = entry.isSymbolicLink() ? await stat(path).catch(() => null) : entry
    if (kind?.isDirectory()) files.push(...await ruleFiles(path, followLinks, depth + 1))
    else if (kind?.isFile() && entry.name.endsWith(".md")) files.push(path)
  }
  return files.slice(0, MAX_RULE_FILES)
}

interface InstructionFile {
  readonly label: string
  readonly path: string
  readonly followLinks: boolean
}

const instructionFiles = async (root: string, home: string): Promise<ReadonlyArray<InstructionFile>> => {
  const userRules = join(home, ".claude", "rules")
  const projectRules = join(root, ".claude", "rules")
  const projectRulesExist = await isRealDirectory(join(root, ".claude")) && await isRealDirectory(projectRules)
  return [
    { label: "~/.claude/CLAUDE.md", path: join(home, ".claude", "CLAUDE.md"), followLinks: true },
    ...(await ruleFiles(userRules, true)).map((path) => ({
      label: `~/.claude/rules/${relative(userRules, path)}`, path, followLinks: true
    })),
    ...FILES.map((name) => ({ label: name, path: join(root, name), followLinks: false })),
    ...(projectRulesExist ? await ruleFiles(projectRules, false) : []).map((path) => ({
      label: relative(root, path), path, followLinks: false
    }))
  ]
}

/**
 * The instruction files a native Claude Code session would load: user
 * `~/.claude/CLAUDE.md` and rules, then the workspace's AGENTS.md, CLAUDE.md
 * and `.claude/rules`. Jingler runs harnesses with their own setting sources
 * off, so this layer is the only way these reach the agent.
 */
export const projectInstructionsLayer = async (
  cwd: string,
  home: string = homedir()
): Promise<PromptLayer | null> => {
  const root = await realpath(cwd)
  const candidates = await instructionFiles(root, home)
  const loaded = (await Promise.all(candidates.map(async ({ label, path, followLinks }) => {
    const target = followLinks ? await realpath(path).catch(() => null) : path
    const content = target === null ? null : await readBoundedFile(target, label, MAX_FILE_BYTES)
    return content ? [{ label, content }] : []
  }))).flat()
  return loaded.length === 0
    ? null
    : promptLayer(
        "workspace",
        "workspace.project-instructions",
        [
          "Follow these instruction files unless they conflict with higher-priority Jingler or operator instructions.",
          `Loaded: ${loaded.map(({ label }) => label).join(", ")}`,
          ...loaded.map(({ label, content }) => `## ${label}\n${content}`)
        ].join("\n\n")
      )
}
