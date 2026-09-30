import { constants, type Stats } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { join } from "node:path"
import { promptLayer } from "./role-profiles.js"
import type { PromptLayer } from "./prompt-compiler.js"

const FILES = ["AGENTS.md", "CLAUDE.md"] as const
const MAX_FILE_BYTES = 32 * 1024

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

const readBoundedRootFile = async (
  root: string,
  name: typeof FILES[number],
  limit: number
): Promise<string | null> => {
  const path = join(root, name)
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

export const projectInstructionsLayer = async (cwd: string): Promise<PromptLayer | null> => {
  const root = await realpath(cwd)
  const files = await Promise.all(
    FILES.map((name) => readBoundedRootFile(root, name, MAX_FILE_BYTES))
  )
  const sections = files.flatMap((content, index) =>
    content ? [`## ${FILES[index]}\n${content}`] : []
  )
  return sections.length === 0
    ? null
    : promptLayer(
        "workspace",
        "workspace.project-instructions",
        [
          "Follow these workspace-root project instructions unless they conflict with higher-priority Jingler or operator instructions.",
          ...sections
        ].join("\n\n")
      )
}
