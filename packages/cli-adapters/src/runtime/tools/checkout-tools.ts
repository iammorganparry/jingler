import { randomBytes } from "node:crypto"
import { resolve } from "node:path"
import { Effect, Schema } from "effect"
import {
  activeCheckoutOf,
  checkoutsOf,
  reduceCheckouts,
  type Project,
  type SessionCheckout,
  type StreamEvent,
  type Worktree
} from "@jingler/core"
import { INTERACTIVE_TOOL_TIMEOUT_MS, ToolError, type ToolRegistry, type WorkspaceCwd } from "./tool-registry.js"

/** The session slice the checkout reducer reads and rewrites. */
export type CheckoutSessionState = Parameters<typeof activeCheckoutOf>[0]

/** What `switch_checkout` needs from the host that owns the session. */
export interface CheckoutHost {
  readonly session: () => CheckoutSessionState
  /** Persist the reducer's result; `session()` must return it afterwards. */
  readonly save: (next: CheckoutSessionState) => Promise<void>
  readonly projects: () => Promise<ReadonlyArray<Pick<Project, "id" | "name" | "path">>>
  /** Ask the operator whether an unregistered repo may be attached; resolves to their decision. */
  readonly approveRepo: (repoPath: string) => Promise<boolean>
  /** Register an operator-approved repo as a project. */
  readonly registerProject: (repoPath: string) => Promise<Pick<Project, "id" | "name" | "path">>
  /** Fork an isolated worktree of `repoPath`; `baseBranch` undefined means the repo default. */
  readonly createWorktree: (input: {
    readonly repoPath: string
    readonly repoName: string
    readonly slug: string
    readonly baseBranch: string | undefined
  }) => Promise<Worktree>
}

/**
 * Directory the agent's tools operate in: the active checkout's worktree,
 * else its repo, else the session's scratch folder (Auto, before any
 * `switch_checkout`) — `session().worktreePath` doubles as that scratch path
 * for a zero-checkout session, same field `resolveTurnWorktree` resolves.
 */
export const activeCheckoutCwd = (host: CheckoutHost): string => {
  const session = host.session()
  const checkout = activeCheckoutOf(session)
  const cwd = checkout.worktreePath ?? checkout.repoPath ?? session.worktreePath
  if (cwd === undefined) throw new ToolError("execution-failed", "Active checkout has no directory")
  return cwd
}

/** A host that always delegates to whichever host `current()` returns right now. */
export const liveCheckoutHost = (current: () => CheckoutHost): CheckoutHost => ({
  session: () => current().session(),
  save: (next) => current().save(next),
  projects: () => current().projects(),
  approveRepo: (repoPath) => current().approveRepo(repoPath),
  registerProject: (repoPath) => current().registerProject(repoPath),
  createWorktree: (input) => current().createWorktree(input)
})

/** The cwd every workspace tool resolves per call: the active checkout when the session has a host, else the fixed run cwd. */
export const toolCwd = (fallback: WorkspaceCwd, host: CheckoutHost | undefined): WorkspaceCwd =>
  host === undefined ? fallback : () => activeCheckoutCwd(host)

const sameRepoPath = (a: string | undefined, b: string): boolean => a !== undefined && resolve(a) === resolve(b)

type FoundProject = Pick<Project, "id" | "name" | "path">

/** Look the project up by name or path; an unregistered path needs operator approval and is then registered. */
const resolveProject = async (
  host: CheckoutHost,
  project: string | undefined,
  repoPath: string | undefined
): Promise<FoundProject | { readonly status: "denied"; readonly repoPath: string }> => {
  const found = (await host.projects()).find((p) =>
    project !== undefined ? p.name.toLowerCase() === project.toLowerCase() : sameRepoPath(p.path, repoPath!)
  )
  if (found !== undefined) return found
  if (project !== undefined) throw new ToolError("invalid-input", `No registered project named "${project}"`)
  const resolved = resolve(repoPath!)
  if (!(await host.approveRepo(resolved))) return { status: "denied", repoPath: resolved }
  return host.registerProject(resolved)
}

const switchExisting = (
  session: CheckoutSessionState,
  existing: SessionCheckout,
  name: string,
  branch: string | undefined
): CheckoutSessionState => {
  if (branch !== undefined && branch !== existing.branch) {
    throw new ToolError("invalid-input", `${name} is already attached on branch ${existing.branch}`)
  }
  return reduceCheckouts(session, { type: "switch", checkoutId: existing.id })
}

const attachNew = async (
  host: CheckoutHost,
  session: CheckoutSessionState,
  found: FoundProject,
  branch: string | undefined
): Promise<CheckoutSessionState> => {
  const slug = `${found.name.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}-${randomBytes(3).toString("hex")}`
  const worktree = await host.createWorktree({ repoPath: found.path, repoName: found.name, slug, baseBranch: branch })
  const checkout: SessionCheckout = {
    id: `co_${slug}`,
    projectId: found.id,
    repo: found.name,
    repoPath: found.path,
    worktreePath: worktree.path,
    workspaceMode: "worktree",
    branch: worktree.branch,
    baseBranch: worktree.baseBranch,
    prNumber: null
  }
  return reduceCheckouts(session, { type: "attach", checkout })
}

export const registerCheckoutTool = (
  registry: ToolRegistry,
  host: CheckoutHost,
  publishEvent: (event: StreamEvent) => Effect.Effect<void>
): void => {
  registry.register({
    id: "switch_checkout",
    version: "1",
    description:
      "Work in another repository of this session. Give a registered project name or a repo path; Jingler attaches an isolated worktree (or re-activates the one already attached) and every later tool call runs there. An unregistered path asks the operator for approval; approving registers it as a project, denying attaches nothing.",
    input: Schema.Struct({
      project: Schema.optional(Schema.String),
      repoPath: Schema.optional(Schema.String),
      branch: Schema.optional(Schema.String)
    }),
    risk: "read",
    roles: ["conversation", "plan-execution"],
    modes: ["ask", "accept-edits", "auto", "plan", "read-only"],
    timeoutMs: INTERACTIVE_TOOL_TIMEOUT_MS,
    outputBudget: 16_000,
    cancellable: true,
    idempotency: "safe",
    execute: async ({ project, repoPath, branch }) => {
      if (project === undefined && repoPath === undefined) {
        throw new ToolError("invalid-input", "Provide a project name or a repoPath")
      }
      const session = host.session()
      const found = await resolveProject(host, project, repoPath)
      if ("status" in found) return found
      const existing = checkoutsOf(session).find((c) => sameRepoPath(c.repoPath, found.path))
      const next = existing === undefined ? await attachNew(host, session, found, branch) : switchExisting(session, existing, found.name, branch)
      await host.save(next)
      const active = activeCheckoutOf(next)
      await Effect.runPromise(publishEvent({
        _tag: "Assistant",
        text: `Switched to \`${active.repo}\` · \`${active.branch}\``
      }))
      return { status: "switched", repo: active.repo, branch: active.branch, cwd: activeCheckoutCwd(host), created: existing === undefined }
    }
  })
}
