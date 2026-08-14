import { open, realpath } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"

export interface WorkspaceInstructionSource {
  readonly path: string
  readonly content: string
  readonly truncated: boolean
  readonly trust: "workspace-untrusted"
}

export interface WorkspaceInstructionResult {
  readonly sources: ReadonlyArray<WorkspaceInstructionSource>
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }>
  readonly content: string
}

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const

const directoriesBetween = (root: string, cwd: string): ReadonlyArray<string> => {
  const nested = relative(root, cwd)
  if (nested === "") return [root]
  const parts = nested.split(sep).filter(Boolean)
  return [root, ...parts.map((_, index) => join(root, ...parts.slice(0, index + 1)))]
}

const isInside = (root: string, target: string): boolean =>
  target === root || target.startsWith(`${root}${sep}`)

type CandidateRead =
  | { readonly kind: "missing" }
  | { readonly kind: "skipped"; readonly path: string; readonly reason: string }
  | { readonly kind: "file"; readonly path: string; readonly bytes: Uint8Array; readonly oversized: boolean }

const readCandidate = async (
  root: string,
  candidate: string,
  maxBytes: number
): Promise<CandidateRead> => {
  let target: string
  try {
    target = await realpath(candidate)
  } catch {
    return { kind: "missing" }
  }
  if (!isInside(root, target)) {
    return { kind: "skipped", path: candidate, reason: "symlink escapes workspace" }
  }
  const handle = await open(target, "r")
  try {
    const info = await handle.stat()
    if (!info.isFile()) return { kind: "skipped", path: candidate, reason: "not a regular file" }
    const bytes = new Uint8Array(maxBytes + 1)
    const read = await handle.read(bytes, 0, bytes.length, 0)
    return {
      kind: "file",
      path: candidate,
      bytes: bytes.subarray(0, Math.min(read.bytesRead, maxBytes)),
      oversized: read.bytesRead > maxBytes
    }
  } finally {
    await handle.close()
  }
}

/** Reads only explicitly named workspace instructions and never pi ambient context. */
export const loadWorkspaceInstructions = async (input: {
  readonly root: string
  readonly cwd?: string
  readonly maxFileBytes?: number
  readonly maxTotalBytes?: number
}): Promise<WorkspaceInstructionResult> => {
  const root = await realpath(input.root)
  const cwd = await realpath(resolve(input.cwd ?? root))
  if (!isInside(root, cwd)) throw new Error("workspace instruction cwd is outside root")

  const maxFileBytes = input.maxFileBytes ?? 16_384
  let remaining = input.maxTotalBytes ?? 32_768
  const sources: Array<WorkspaceInstructionSource> = []
  const skipped: Array<{ readonly path: string; readonly reason: string }> = []

  const candidates = directoriesBetween(root, cwd).flatMap((directory) =>
    INSTRUCTION_FILES.map((name) => join(directory, name))
  )
  const reads = await Promise.all(candidates.map((candidate) => readCandidate(root, candidate, maxFileBytes)))
  for (const read of reads) {
      if (read.kind === "missing") continue
      if (read.kind === "skipped") {
        skipped.push({ path: read.path, reason: read.reason })
        continue
      }
      if (remaining === 0) {
        skipped.push({ path: read.path, reason: "total instruction budget exhausted" })
        continue
      }
      const cap = Math.min(maxFileBytes, remaining)
      const truncated = read.oversized || read.bytes.byteLength > cap
      const content = new TextDecoder("utf-8", { fatal: false }).decode(read.bytes.subarray(0, cap))
      remaining -= Math.min(read.bytes.byteLength, cap)
      sources.push({
        path: relative(root, read.path),
        content,
        truncated,
        trust: "workspace-untrusted"
      })
  }

  return {
    sources,
    skipped,
    content: sources.map((source) => [
      `<workspace-instructions source="${source.path}" trust="untrusted">`,
      source.content,
      "</workspace-instructions>"
    ].join("\n")).join("\n\n")
  }
}
