import { execFileSync } from "node:child_process"
import type { SubagentFleetWorkspace } from "@jingler/core"

const git = (cwd: string, ...args: string[]): string | null => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return null
  }
}

/**
 * The git worktree a child runs in, or null when it shares the parent's checkout
 * (or is not in a git checkout at all). baseRef is not recorded by the runtime.
 */
export const childWorkspace = (
  childCwd: string | undefined,
  parentCwd: string | undefined
): SubagentFleetWorkspace | null => {
  if (childCwd === undefined || parentCwd === undefined) return null
  const path = git(childCwd, "rev-parse", "--show-toplevel")
  const branch = git(childCwd, "rev-parse", "--abbrev-ref", "HEAD")
  if (path === null || branch === null || path === git(parentCwd, "rev-parse", "--show-toplevel")) return null
  return { path, branch, baseRef: null }
}
