import { worktreeEnv } from "./worktree-env.js"
import { activeCheckoutOf, type Session } from "@jingler/core"

export const workspaceEnvironment = (session: Parameters<typeof activeCheckoutOf>[0] & Pick<Session, "environmentId">): Record<string, string> => {
  const checkout = activeCheckoutOf(session)
  if (session.environmentId || checkout.workspaceMode === "direct" || !checkout.worktreePath) return {}
  return {
    JINGLER_WORKSPACE_PATH: checkout.worktreePath,
    ...(checkout.repoPath ? { JINGLER_ROOT_PATH: checkout.repoPath } : {}),
  }
}

/** Only the host-owned workspace keys may bypass native CLI credential filtering. */
export const trustedWorkspaceEnvironment = (environment: Readonly<Record<string, string>> = {}): Record<string, string> =>
  Object.fromEntries(Object.entries(environment).filter(([name, value]) =>
    (name === "JINGLER_WORKSPACE_PATH" || name === "JINGLER_ROOT_PATH") && !value.includes("\0")))

export const workspaceProcessEnvironment = (environment: Record<string, string | undefined>, session: Parameters<typeof activeCheckoutOf>[0] & Pick<Session, "environmentId">): Record<string, string> => ({
  ...worktreeEnv(environment, activeCheckoutOf(session).worktreePath ?? undefined), ...workspaceEnvironment(session)
})
