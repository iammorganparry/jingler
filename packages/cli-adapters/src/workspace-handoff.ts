import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import type { WorkspaceTransferCheckpoint } from "@jingler/core"
import { Schema } from "effect"
import { WorkspaceTransferCheckpoint as WorkspaceTransferCheckpointSchema } from "@jingler/core"
import { parseGitHubRemote } from "./github-remote.js"

const execFileAsync = promisify(execFile)
const MAX_TRANSFER_BYTES = 4 * 1024 * 1024

const git = async (
  cwd: string,
  args: readonly string[],
  trim = true
): Promise<string> => {
  const result = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_TRANSFER_BYTES + 1024 * 1024
  })
  return trim ? result.stdout.trimEnd() : result.stdout
}

const safeRelativePath = (value: string): string => {
  if (
    value.length === 0 ||
    isAbsolute(value) ||
    value.split(/[\\/]/u).some((part) => part === ".." || part === "")
  ) {
    throw new Error("Workspace handoff contains an unsafe path")
  }
  return value
}

const applyPatch = async (
  cwd: string,
  patch: string,
  staged: boolean
): Promise<void> => {
  if (patch.length === 0) return
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("git", ["apply", "--binary", ...(staged ? ["--index"] : [])], {
      cwd,
      shell: false,
      stdio: ["pipe", "ignore", "pipe"]
    })
    let error = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => { error += chunk })
    child.once("error", reject)
    child.once("close", (code) => {
      code === 0
        ? resolvePromise()
        : reject(new Error(`Workspace handoff patch failed: ${error.trim()}`))
    })
    child.stdin.end(patch)
  })
}

export const exportWorkspaceHandoff = async (input: {
  readonly workspacePath: string
  readonly sourceSessionId: string
  readonly eventCursor: number
}): Promise<WorkspaceTransferCheckpoint> => {
  const workspacePath = await realpath(input.workspacePath)
  const [headSha, branch, remote, stagedPatch, unstagedPatch, untracked] = await Promise.all([
    git(workspacePath, ["rev-parse", "HEAD"]),
    git(workspacePath, ["branch", "--show-current"]),
    git(workspacePath, ["remote", "get-url", "origin"]).catch(() => ""),
    git(workspacePath, ["diff", "--binary", "--cached", "--no-ext-diff"], false),
    git(workspacePath, ["diff", "--binary", "--no-ext-diff"], false),
    git(workspacePath, ["ls-files", "--others", "--exclude-standard", "-z"])
  ])
  const paths = untracked.length === 0 ? [] : untracked.split("\0").filter(Boolean)
  const parsedRemote = parseGitHubRemote(remote)
  const untrackedFiles: Array<{ path: string; contentBase64: string }> = []
  let size = Buffer.byteLength(stagedPatch) + Buffer.byteLength(unstagedPatch)
  for (const candidate of paths) {
    const path = safeRelativePath(candidate)
    const absolute = resolve(workspacePath, path)
    const inside = relative(workspacePath, absolute)
    if (inside.startsWith(`..${sep}`) || inside === "..") {
      throw new Error("Workspace handoff path escapes its repository")
    }
    const stat = await lstat(absolute)
    if (!stat.isFile()) throw new Error("Workspace handoff supports regular files only")
    const content = await readFile(absolute)
    size += content.byteLength
    if (size > MAX_TRANSFER_BYTES) {
      throw new Error("Workspace handoff exceeds the 4 MiB transfer limit")
    }
    untrackedFiles.push({ path, contentBase64: content.toString("base64") })
  }
  return Schema.decodeUnknownSync(WorkspaceTransferCheckpointSchema)({
    version: 1,
    checkpointId: `handoff_${randomUUID().replaceAll("-", "")}`,
    sourceSessionId: input.sourceSessionId,
    repositorySlug:
      parsedRemote === null ? null : `${parsedRemote.owner}/${parsedRemote.repo}`,
    headSha,
    branch: branch || null,
    stagedPatch,
    unstagedPatch,
    untrackedFiles,
    eventCursor: input.eventCursor
  }, { onExcessProperty: "error" })
}

export const importWorkspaceHandoff = async (
  workspacePath: string,
  checkpoint: WorkspaceTransferCheckpoint
): Promise<void> => {
  const decoded = Schema.decodeUnknownSync(WorkspaceTransferCheckpointSchema)(checkpoint, {
    onExcessProperty: "error"
  })
  const root = await realpath(workspacePath)
  const headSha = await git(root, ["rev-parse", "HEAD"])
  if (headSha.toLowerCase() !== decoded.headSha.toLowerCase()) {
    throw new Error("Target workspace HEAD does not match the handoff checkpoint")
  }
  await applyPatch(root, decoded.stagedPatch, true)
  await applyPatch(root, decoded.unstagedPatch, false)
  for (const file of decoded.untrackedFiles) {
    const path = safeRelativePath(file.path)
    const absolute = resolve(root, path)
    const inside = relative(root, absolute)
    if (inside.startsWith(`..${sep}`) || inside === "..") {
      throw new Error("Workspace handoff path escapes its repository")
    }
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, Buffer.from(file.contentBase64, "base64"), { flag: "wx" })
  }
  const restoredHead = await git(root, ["rev-parse", "HEAD"])
  if (restoredHead.toLowerCase() !== decoded.headSha.toLowerCase()) {
    throw new Error("Restored workspace identity does not match the handoff checkpoint")
  }
}

/** Prepare a newly-created local continuation at the source's exact commit. */
export const checkoutWorkspaceHandoffBase = async (
  workspacePath: string,
  checkpoint: WorkspaceTransferCheckpoint
): Promise<void> => {
  const decoded = Schema.decodeUnknownSync(WorkspaceTransferCheckpointSchema)(checkpoint, {
    onExcessProperty: "error"
  })
  const root = await realpath(workspacePath)
  await git(root, ["checkout", "--detach", decoded.headSha])
}
