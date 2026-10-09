import { worktreeEnv } from "./worktree-env.js"
import type { Session } from "@jingler/core"

export const workspaceEnvironment = (session: Pick<Session, "worktreePath" | "repoPath" | "environmentId" | "workspaceMode">): Record<string, string> => {
  if (session.environmentId || session.workspaceMode === "direct" || !session.worktreePath) return {}
  return {
    JINGLER_WORKSPACE_PATH: session.worktreePath,
    ...(session.repoPath ? { JINGLER_ROOT_PATH: session.repoPath } : {}),
  }
}

/** Only the host-owned workspace keys may bypass native CLI credential filtering. */
export const trustedWorkspaceEnvironment = (environment: Readonly<Record<string, string>> = {}): Record<string, string> =>
  Object.fromEntries(Object.entries(environment).filter(([name, value]) =>
    (name === "JINGLER_WORKSPACE_PATH" || name === "JINGLER_ROOT_PATH") && !value.includes("\0")))

export const workspaceProcessEnvironment = (environment: Record<string, string | undefined>, session: Pick<Session, "worktreePath" | "repoPath" | "environmentId" | "workspaceMode">): Record<string, string> => ({
  ...worktreeEnv(environment, session.worktreePath ?? undefined), ...workspaceEnvironment(session)
})
