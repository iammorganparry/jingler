import type { Project, Worktree } from "@jingler/core"
import type { CheckoutHost, CheckoutSessionState } from "./runtime/tools/checkout-tools.js"
import type { CreateWorktreeInput } from "./git.js"

/** Everything `makeCheckoutHost` needs from the app, as plain promises so it is testable without Effect layers. */
export interface CheckoutHostDeps {
  readonly session: CheckoutSessionState
  readonly listProjects: () => Promise<ReadonlyArray<Project>>
  readonly registerProject: (repoPath: string) => Promise<Project>
  /** Persist the checkout state and return the session as stored. */
  readonly persist: (next: CheckoutSessionState) => Promise<CheckoutSessionState>
  readonly createDetachedWorktree: (input: CreateWorktreeInput) => Promise<Worktree>
  readonly defaultBranch: (repoPath: string) => Promise<string>
  /** Park on an operator gate; true when approved. */
  readonly approveRepo: (repoPath: string) => Promise<boolean>
}

/** Per-turn host for `switch_checkout`: holds the live checkout state tools read synchronously. */
export const makeCheckoutHost = (deps: CheckoutHostDeps): CheckoutHost => {
  let current = deps.session
  return {
    session: () => current,
    save: async (next) => {
      current = await deps.persist(next)
    },
    projects: deps.listProjects,
    approveRepo: deps.approveRepo,
    registerProject: deps.registerProject,
    createWorktree: async ({ repoPath, repoName, slug, baseBranch }) =>
      deps.createDetachedWorktree({
        repoPath,
        repoName,
        slug,
        baseBranch: baseBranch ?? (await deps.defaultBranch(repoPath))
      })
  }
}
