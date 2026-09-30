import { open, realpath } from "node:fs/promises"
import { dirname, join } from "node:path"
import { promptLayer } from "./role-profiles.js"
import type { PromptLayer } from "./prompt-compiler.js"

const FILES = ["AGENTS.md", "CLAUDE.md"] as const
const MAX_FILE_BYTES = 32 * 1024

const readBoundedRootFile = async (
  root: string,
  name: typeof FILES[number],
  limit: number
): Promise<string | null> => {
  const path = await realpath(join(root, name)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null
    throw error
  })
  if (path === null || dirname(path) !== root) return null
  const file = await open(path, "r")
  try {
    const buffer = Buffer.alloc(limit)
    const { bytesRead } = await file.read(buffer, 0, limit, 0)
    return buffer.subarray(0, bytesRead).toString("utf8").trim()
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
