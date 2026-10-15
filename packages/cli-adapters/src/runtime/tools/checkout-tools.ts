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
import { INTERACTIVE_TOOL_TIMEOUT_MS, ToolError, type ToolRegistry } from "./tool-registry.js"

/** The session slice the checkout reducer reads and rewrites. */
export type CheckoutSessionState = Parameters<typeof activeCheckoutOf>[0]

/** What `switch_checkout` needs from the host that owns the session. */
export interface CheckoutHost {
  readonly session: () => CheckoutSessionState
  /** Persist the reducer's result; `session()` must return it afterwards. */
  readonly save: (next: CheckoutSessionState) => Promise<void>
  readonly projects: () => Promise<ReadonlyArray<Pick<Project, "id" | "name" | "path">>>
  /** Fork an isolated worktree of `repoPath`; `baseBranch` undefined means the repo default. */
  readonly createWorktree: (input: {
    readonly repoPath: string
    readonly repoName: string
    readonly slug: string
    readonly baseBranch: string | undefined
  }) => Promise<Worktree>
}

/** Directory the agent's tools operate in: the active checkout's worktree, else its repo. */
export const activeCheckoutCwd = (host: CheckoutHost): string => {
  const checkout = activeCheckoutOf(host.session())
  const cwd = checkout.worktreePath ?? checkout.repoPath
  if (cwd === undefined) throw new ToolError("execution-failed", "Active checkout has no directory")
  return cwd
}

const sameRepoPath = (a: string | undefined, b: string): boolean => a !== undefined && resolve(a) === resolve(b)

export const registerCheckoutTool = (
  registry: ToolRegistry,
  host: CheckoutHost,
  publishEvent: (event: StreamEvent) => Effect.Effect<void>
): void => {
  registry.register({
    id: "switch_checkout",
    version: "1",
    description:
      "Work in another repository of this session. Give a registered project name or a repo path; Jingler attaches an isolated worktree (or re-activates the one already attached) and every later tool call runs there. An unregistered path asks the operator for approval and attaches nothing.",
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
      const found = (await host.projects()).find((p) =>
        project !== undefined ? p.name.toLowerCase() === project.toLowerCase() : sameRepoPath(p.path, repoPath!)
      )
      if (found === undefined) {
        if (project !== undefined) throw new ToolError("invalid-input", `No registered project named "${project}"`)
        await Effect.runPromise(publishEvent({
          _tag: "GateRequested",
          gate: {
            id: `switch_checkout_${randomBytes(4).toString("hex")}`,
            kind: "command",
            title: "Attach an unregistered repository?",
            detail: `The agent asked to work in ${resolve(repoPath!)}, which is not a registered project.`,
            command: `switch_checkout ${resolve(repoPath!)}`,
            allowLabel: null,
            status: "pending"
          }
        }))
        return { status: "approval-required", repoPath: resolve(repoPath!) }
      }

      const existing = checkoutsOf(session).find((c) => sameRepoPath(c.repoPath, found.path))
      let next: CheckoutSessionState
      if (existing !== undefined) {
        if (branch !== undefined && branch !== existing.branch) {
          throw new ToolError("invalid-input", `${found.name} is already attached on branch ${existing.branch}`)
        }
        next = reduceCheckouts(session, { type: "switch", checkoutId: existing.id })
      } else {
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
        next = reduceCheckouts(session, { type: "attach", checkout })
      }
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
