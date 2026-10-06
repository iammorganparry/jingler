import { join } from "node:path"
import type { CommandExecutor, FileSystem, Path } from "@effect/platform"
import { GitError, type Session } from "@jingler/core"
import { Effect } from "effect"
import { AppPaths } from "./app-paths.js"
import { SessionStore } from "./sessions.js"
import { WorkspaceCheckpointStore } from "./workspace-checkpoint-store.js"
import { acquireWorkspaceActivity, acquireCheckpointTurnOwner, closeWorkspaceAdmission, reopenWorkspaceAdmission, setWorkspaceCheckpointMode, workspaceActivityCount, workspaceAdmissionReason, type WorkspaceActivity } from "./workspace-admission.js"

const supported = (session: Session): void => {
  if (session.environmentId || session.executionLocation === "cloud" || session.workspaceMode !== "worktree" || !session.worktreePath || session.archived) throw new Error("Checkpoints require an unarchived isolated local worktree.")
  if (session.checkpointExecutionHistory !== "clean") throw new Error("This workspace has prior or unknown interactive-terminal/unsupported execution history. Create a fresh workspace to enable safe checkpoints.")
  if (process.platform === "win32") throw new Error("Checkpoint-safe filesystem operations are unsupported on Windows.")
}
const store = (session: Session, root: string) => new WorkspaceCheckpointStore({ root, sessionId: session.id, cwd: session.worktreePath!, verifiedBranch: session.semanticBranchProposal && session.semanticBranchPending === false ? session.branch : undefined })
const exclusive = async <T>(session: Session, reason: string, operation: () => Promise<T>): Promise<T> => {
  supported(session)
  const readiness = workspaceAdmissionReason(session.id)
  if (readiness) throw new Error(`Workspace is unavailable while ${readiness}.`)
  const closure = closeWorkspaceAdmission(session.id, reason)
  try {
    if (workspaceActivityCount(session.id) > 0) throw new Error("Stop all workspace work before this operation. Active work will never be killed automatically.")
    return await operation()
  } finally { reopenWorkspaceAdmission(session.id, closure) }
}

/** Shared automatic-turn gate, also used by routines and the built-app harness. */
export const acquireCheckpointedTurn = async (session: Session, checkpointRoot: string): Promise<WorkspaceActivity> => {
  setWorkspaceCheckpointMode(session.id, session.checkpointSafeMode === true)
  if (session.checkpointSafeMode !== true) return acquireWorkspaceActivity(session.id, "agent-turn")
  supported(session)
  const selectedRuntime = session.chats.find((chat) => chat.id === session.activeChatId)?.runtimeId ?? session.runtimeId ?? "pi"
  if (selectedRuntime !== "pi") throw new Error("Checkpoint-safe mode currently supports managed Pi tools only; this native harness has unsupported process ownership.")
  const readiness = workspaceAdmissionReason(session.id)
  if (readiness) throw new Error(`Workspace is unavailable while ${readiness}.`)
  const closure = closeWorkspaceAdmission(session.id, "capturing automatic checkpoint")
  try {
    if (workspaceActivityCount(session.id) > 0) throw new Error("Checkpoint-safe turns require a stopped workspace. Stop active work and Retry.")
    await store(session, checkpointRoot).capture("Before agent turn (workspace-wide)")
    return acquireCheckpointTurnOwner(session.id, closure)
  } catch (cause) {
    reopenWorkspaceAdmission(session.id, closure)
    throw new Error(`Checkpoint capture failed; the turn was blocked. Fix the problem and Retry. ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
}

export class WorkspaceCheckpointService extends Effect.Service<WorkspaceCheckpointService>()("@jingler/WorkspaceCheckpointService", {
  accessors: true,
  effect: Effect.gen(function* () {
    const sessions = yield* SessionStore
    const paths = yield* AppPaths
    const environment = yield* Effect.context<FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor | AppPaths>()
    const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor | AppPaths>) => Effect.runPromise(Effect.provide(effect, environment))
    const root = join(paths.root, "checkpoints")
    const operation = <T>(sessionId: string, f: (session: Session) => Promise<T>) => Effect.tryPromise({
      try: async () => f(await run(sessions.get(sessionId))),
      catch: (cause) => new GitError({ message: cause instanceof Error ? cause.message : String(cause), cause })
    })
    return {
      setMode: (sessionId: string, enabled: boolean) => operation(sessionId, (session) => exclusive(session, "changing checkpoint-safe mode", async () => {
        if (enabled) {
          // Validate repository/filesystem support before persisting operator consent.
          await store(session, root).capture("Enabling checkpoint-safe mode")
        }
        await run(sessions.setCheckpointSafeMode(sessionId, enabled))
        return run(sessions.get(sessionId))
      })),
      capture: (sessionId: string, label?: string) => operation(sessionId, (session) => exclusive(session, "capturing checkpoint", () => store(session, root).capture(label))),
      list: (sessionId: string) => operation(sessionId, (session) => { supported(session); return store(session, root).list() }),
      preview: (sessionId: string, checkpointId: string) => operation(sessionId, (session) => exclusive(session, "previewing checkpoint restore", () => store(session, root).preview(checkpointId))),
      restore: (sessionId: string, checkpointId: string, token: string) => operation(sessionId, (session) => exclusive(session, "restoring checkpoint", () => store(session, root).restore(checkpointId, token)))
    }
  })
}) {}
