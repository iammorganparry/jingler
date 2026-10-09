/// <reference lib="es2024.promise" />
import { spawn, type ChildProcess } from "node:child_process"
import { resolve } from "node:path"
import { anchoredFs } from "./anchored-fs.js"
import type { FileSystem, Path, CommandExecutor } from "@effect/platform"
import { GitError, type Session, type WorkspaceRunState } from "@jingler/core"
import { Effect } from "effect"
import type { AppPaths } from "./app-paths.js"
import { trackChild, stopChildAndWait, stopOwnedChildren } from "./child-registry.js"
import { approvedWorkflow, safeWorkflowRelativePath } from "./project-workflow.js"
import { ProjectService } from "./projects.js"
import { SessionStore } from "./sessions.js"
import {
  acquireWorkspaceActivity,
  acquireWorkspaceLifecycleActivity,
  closeWorkspaceAdmission,
  reopenWorkspaceAdmission,
  workspaceActivityCount
} from "./workspace-admission.js"
import { workspaceProcessEnvironment } from "./workspace-environment.js"

// Native Error causes do not survive Electron's context bridge.
const workflowError = (message: string, cause: unknown) => new GitError({ message, cause: String(cause) })

const OUTPUT_LIMIT = 64 * 1024
const COMMAND_TIMEOUT_MS = 10 * 60_000

const safeOutput = (value: string): string =>
  value
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)\S+/giu, "$1[redacted]")
    .slice(-OUTPUT_LIMIT)

const assertShellSupported = (session: Session): void => {
  if (session.checkpointSafeMode) throw new Error("Shell/build/test commands are unsupported in checkpoint-safe mode.")
  if (process.platform === "win32") throw new Error("Workspace commands are not supported on Windows until owned process-tree termination is available.")
}

const runCommand = async (
  session: Session,
  action: string,
  command: string,
  onSpawn?: (child: ChildProcess) => void,
  lifecycleOwner?: symbol,
  timeoutMs: number | null = COMMAND_TIMEOUT_MS
): Promise<{ exitCode: number; output: string }> => {
  assertShellSupported(session)
  if (!session.worktreePath) throw new Error("Workspace checkout is unavailable.")
  const lease = lifecycleOwner
    ? acquireWorkspaceLifecycleActivity(session.id, action, lifecycleOwner)
    : acquireWorkspaceActivity(session.id, action)
  let ownedChild: ChildProcess | undefined
  try {
    const child = trackChild(spawn(process.env.SHELL || "/bin/sh", ["-lc", command], {
      cwd: session.worktreePath,
      env: workspaceProcessEnvironment(process.env, session),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    }), true, { sessionId: session.id, action, onStopped: () => lease.release() })
    ownedChild = child
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn)
      child.once("error", rejectSpawn)
    })
    onSpawn?.(child)
    let output = ""
    const append = (chunk: Buffer | string) => { output = safeOutput(output + String(chunk)) }
    child.stdout?.on("data", append)
    child.stderr?.on("data", append)
    const result = await new Promise<{ exitCode: number; output: string }>((resolveResult, reject) => {
      const timeout = timeoutMs === null ? undefined : setTimeout(() => {
        void stopOwnedChildren(session.id, action).then(() => reject(new Error("Workspace command timed out.")), reject)
      }, timeoutMs)
      timeout?.unref?.()
      child.once("error", (cause) => {
        clearTimeout(timeout)
        reject(cause)
      })
      child.once("exit", (code) => {
        clearTimeout(timeout)
        resolveResult({ exitCode: code ?? 1, output: safeOutput(output) })
      })
    })
    await stopChildAndWait(child, 0)
    return result
  } finally {
    if (ownedChild) await stopChildAndWait(ownedChild, 0)
    else lease.release()
  }
}

const isIgnored = async (root: string, relative: string): Promise<boolean> => {
  try { await anchoredFs.git(root, ["check-ignore", "--quiet", "--", relative]); return true }
  catch (cause) { if ((cause as { code?: number }).code === 1) return false; throw cause }
}

export const copyApprovedFile = async (root: string, targetRoot: string, configured: string): Promise<void> => {
  const relative = safeWorkflowRelativePath(configured)
  if (!relative) throw new Error(`Unsafe copied-file path: ${configured}`)
  if (!(await isIgnored(root, relative))) throw new Error(`Copied file is not ignored by Git: ${relative}`)
  const source = await anchoredFs.read(resolve(root, relative), 16 * 1024 * 1024)
  if (source.nlink !== 1) throw new Error("Unsafe copied-file source hardlink.")
  const destination = await anchoredFs.stat(resolve(targetRoot, relative))
  if (destination && (!destination.file || destination.nlink !== 1)) throw new Error("Unsafe copied-file destination.")
  await anchoredFs.write(resolve(targetRoot, relative), source.bytes, 0o600)
}

export class WorkspaceWorkflowService extends Effect.Service<WorkspaceWorkflowService>()(
  "@jingler/WorkspaceWorkflowService",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const projects = yield* ProjectService
      const sessions = yield* SessionStore
      const env = yield* Effect.context<
        FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor | AppPaths
      >()
      const runEffect = <A, E>(effect: Effect.Effect<
        A,
        E,
        FileSystem.FileSystem | Path.Path | CommandExecutor.CommandExecutor | AppPaths
      >): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(env)))
      const runs = new Map<string, Map<string, WorkspaceRunState>>()
      const setupClosures = new Map<string, symbol>()
      const operations = new Set<string>()
      const pendingRuns = new Set<string>()

      const lifecycle = (sessionId: string, status: NonNullable<Session["workspaceLifecycle"]>["status"], extra: { error?: string; output?: string } = {}) =>
        sessions.setWorkspaceLifecycle(sessionId, {
          status,
          updatedAt: new Date().toISOString(),
          ...extra
        })

      const setup = (sessionId: string) => {
        let owned = false
        return Effect.tryPromise({
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: setup deliberately keeps approval, copy, command, persistence, and admission in one failure boundary.
        try: async () => {
          if (operations.has(sessionId)) throw new Error("Workspace lifecycle operation is already in progress.")
          operations.add(sessionId)
          try {
          const session = await runEffect(sessions.get(sessionId))
          if (session.environmentId || session.workspaceMode === "direct" || !session.projectId) {
            await runEffect(lifecycle(sessionId, "ready"))
            return await runEffect(sessions.get(sessionId))
          }
          const previous = setupClosures.get(sessionId)
          if (previous) {
            if (workspaceActivityCount(sessionId) > 0) throw new Error("Previous workspace setup is still stopping.")
            if (session.workspaceLifecycle?.status !== "setup-failed") throw new Error("Workspace setup is already in progress.")
            if (!reopenWorkspaceAdmission(sessionId, previous)) throw new Error("Workspace setup ownership changed.")
          }
          const closure = closeWorkspaceAdmission(sessionId, "workspace setup is incomplete")
          setupClosures.set(sessionId, closure)
          owned = true
          await runEffect(lifecycle(sessionId, "setup-running"))
          const project = await runEffect(projects.get(session.projectId))
          const workflow = approvedWorkflow(project.workflow)
          if (project.workflow && !workflow) throw new Error("Project workflow changed and needs operator approval.")
          if (workflow) {
            for (const file of workflow.copyFiles) await copyApprovedFile(project.path, session.worktreePath!, file)
            if (workflow.setup) {
              assertShellSupported(session)
              await runEffect(sessions.markCheckpointExecutionUnprovable(sessionId))
              const result = await runCommand(session, "setup", workflow.setup, undefined, closure)
              if (result.exitCode !== 0) throw Object.assign(new Error(`Setup exited with code ${result.exitCode}.`), { output: result.output })
            }
          }
          await runEffect(lifecycle(sessionId, "ready"))
          if (reopenWorkspaceAdmission(sessionId, closure)) setupClosures.delete(sessionId)
          return await runEffect(sessions.get(sessionId))
          } finally { operations.delete(sessionId) }
        },
        catch: (cause) => cause
      }).pipe(
        Effect.tapError((cause) => (!owned ? Effect.void : lifecycle(sessionId, "setup-failed", {
          error: cause instanceof Error ? cause.message : String(cause),
          ...((cause as { output?: unknown })?.output && typeof (cause as { output?: unknown }).output === "string"
            ? { output: (cause as { output: string }).output }
            : {})
        }).pipe(Effect.ignore))),
        Effect.mapError((cause) => workflowError(cause instanceof Error ? cause.message : "Workspace setup failed", cause)),
        Effect.provide(env)
      )
      }

      const skipSetup = (sessionId: string) =>
        Effect.gen(function* () {
          if (operations.has(sessionId)) return yield* Effect.fail(new GitError({ message: "Workspace lifecycle operation is already in progress." }))
          if (workspaceActivityCount(sessionId) > 0) return yield* Effect.fail(new GitError({ message: "Workspace activity is still stopping." }))
          operations.add(sessionId)
          yield* Effect.addFinalizer(() => Effect.sync(() => operations.delete(sessionId)))
          const session = yield* sessions.get(sessionId).pipe(Effect.mapError((cause) => workflowError("Could not reload workspace", cause)))
          if (session.workspaceLifecycle?.status === "setup-running") {
            return yield* Effect.fail(new GitError({ message: "Cannot skip setup while it is running." }))
          }
          const closure = yield* Effect.try({
            try: () => setupClosures.get(sessionId) ?? closeWorkspaceAdmission(sessionId, "workspace setup is incomplete"),
            catch: (cause) => workflowError(cause instanceof Error ? cause.message : "Workspace is unavailable", cause)
          })
          const lease = yield* Effect.try({
            try: () => acquireWorkspaceLifecycleActivity(sessionId, "skip-setup", closure),
            catch: (cause) => workflowError("Workspace setup ownership changed", cause)
          })
          yield* Effect.addFinalizer(() => Effect.sync(() => lease.release()))
          yield* lifecycle(sessionId, "setup-skipped")
          if (!reopenWorkspaceAdmission(sessionId, closure)) {
            return yield* Effect.fail(new GitError({ message: "Workspace ownership changed while setup was being skipped." }))
          }
          setupClosures.delete(sessionId)
          return yield* sessions.get(sessionId).pipe(
            Effect.mapError((cause) => workflowError("Could not reload workspace", cause))
          )
        }).pipe(Effect.scoped, Effect.provide(env))

      // Transfer only an idle failed setup to archive/delete. Public readiness stays closed.
      const prepareLifecycle = (sessionId: string) => Effect.tryPromise({
        try: async () => {
          const owner = setupClosures.get(sessionId)
          if (!owner) return
          const session = await runEffect(sessions.get(sessionId))
          if (operations.has(sessionId) || workspaceActivityCount(sessionId) > 0 || session.workspaceLifecycle?.status !== "setup-failed") throw new Error("Workspace setup must stop before archive or deletion.")
          if (!reopenWorkspaceAdmission(sessionId, owner)) throw new Error("Workspace setup ownership changed.")
          setupClosures.delete(sessionId)
        },
        catch: (cause) => workflowError(cause instanceof Error ? cause.message : "Workspace is unavailable", cause)
      })

      const executeCleanup = async (sessionId: string, owner: symbol) => {
          const session = await runEffect(sessions.get(sessionId))
          await runEffect(lifecycle(sessionId, "cleanup-running"))
          if (session.environmentId || session.workspaceMode === "direct") throw new Error("Workspace cleanup requires an isolated local worktree.")
          if (!session.projectId) return
          const project = await runEffect(projects.get(session.projectId))
          const workflow = approvedWorkflow(project.workflow)
          if (project.workflow && !workflow) throw new Error("Project workflow changed and needs operator approval before cleanup.")
          if (workflow?.cleanup) {
            assertShellSupported(session)
            await runEffect(sessions.markCheckpointExecutionUnprovable(sessionId))
            const result = await runCommand(session, "cleanup", workflow.cleanup, undefined, owner)
            if (result.exitCode !== 0) throw Object.assign(new Error(`Cleanup exited with code ${result.exitCode}.`), { output: result.output })
          }
      }

      const cleanup = (sessionId: string, owner: symbol) => {
        let admitted = false
        return Effect.tryPromise({
        try: async () => {
          const lease = acquireWorkspaceLifecycleActivity(sessionId, "cleanup", owner)
          admitted = true
          try {
            await executeCleanup(sessionId, owner)
            await runEffect(lifecycle(sessionId, "ready"))
          } finally { lease.release() }
        },
        catch: (cause) => cause
      }).pipe(
        Effect.tapError((cause) => (admitted ? lifecycle(sessionId, "cleanup-failed", {
          error: cause instanceof Error ? cause.message : String(cause),
          ...((cause as { output?: unknown })?.output && typeof (cause as { output?: unknown }).output === "string"
            ? { output: (cause as { output: string }).output }
            : {})
        }).pipe(Effect.ignore) : Effect.void)),
        Effect.mapError((cause) => workflowError(cause instanceof Error ? cause.message : "Workspace cleanup failed", cause)),
        Effect.provide(env)
      )
      }

      const commandForRun = async (sessionId: string, runId: string) => {
        const session = await runEffect(sessions.get(sessionId))
        if (session.environmentId || session.workspaceMode === "direct") throw new Error("Workspace commands require an isolated local worktree.")
        if (!session.projectId || (session.workspaceLifecycle?.status !== "ready" && session.workspaceLifecycle?.status !== "setup-skipped")) throw new Error("Workspace setup must finish before running project commands.")
        const project = await runEffect(projects.get(session.projectId))
        const workflow = approvedWorkflow(project.workflow)
        if (!workflow) throw new Error("Project workflow needs operator approval.")
        const command = workflow.runs.find((candidate) => candidate.id === runId)
        if (!command) throw new Error("Unknown project run command.")
        return { session, command }
      }

      const startRun = (sessionId: string, runId: string) => Effect.tryPromise({
        try: async () => {
          const key = `${sessionId}:${runId}`
          if (pendingRuns.has(key)) throw new Error("Project command is already starting.")
          pendingRuns.add(key)
          try {
          const { session, command } = await commandForRun(sessionId, runId)
          const sessionRuns = runs.get(sessionId) ?? new Map<string, WorkspaceRunState>()
          if (sessionRuns.get(runId)?.status === "running") throw new Error(`${command.label} is already running.`)
          const startedAt = new Date().toISOString()
          const state: WorkspaceRunState = { id: runId, label: command.label, status: "running", startedAt }
          const { promise: spawned, resolve: resolveSpawn, reject: rejectSpawn } = Promise.withResolvers<void>()
          assertShellSupported(session)
          await runEffect(sessions.markCheckpointExecutionUnprovable(sessionId))
          const resultPromise = runCommand(session, `run:${runId}`, command.command, () => {
            sessionRuns.set(runId, state)
            runs.set(sessionId, sessionRuns)
            resolveSpawn()
          }, undefined, null)
          void resultPromise.catch(rejectSpawn)
          await spawned
          void resultPromise.then((result) => {
            sessionRuns.set(runId, {
              ...state,
              status: result.exitCode === 0 ? "exited" : "failed",
              exitCode: result.exitCode,
              ...(result.output ? { output: result.output } : {})
            })
          }).catch((cause) => {
            const current = sessionRuns.get(runId)
            if (current) sessionRuns.set(runId, { ...state, status: "failed", output: safeOutput(cause instanceof Error ? cause.message : String(cause)) })
          })
          return state
          } finally { pendingRuns.delete(key) }
        },
        catch: (cause) => workflowError(cause instanceof Error ? cause.message : "Could not run project command", cause)
      })

      const stopRun = (sessionId: string, runId: string) =>
        Effect.tryPromise({
          try: async () => { await stopOwnedChildren(sessionId, `run:${runId}`) },
          catch: (cause) => workflowError("Could not stop project command", cause)
        })

      const stopAll = (sessionId: string) => Effect.tryPromise({
        try: async () => { await stopOwnedChildren(sessionId) },
        catch: (cause) => workflowError("Could not stop workspace commands", cause)
      })

      const listRuns = (sessionId: string): Effect.Effect<ReadonlyArray<WorkspaceRunState>> =>
        Effect.sync(() => [...(runs.get(sessionId)?.values() ?? [])])

      const forget = (sessionId: string) => stopAll(sessionId).pipe(Effect.andThen(Effect.sync(() => runs.delete(sessionId))))

      return { setup, skipSetup, prepareLifecycle, cleanup, startRun, stopRun, stopAll, listRuns, forget }
    })
  }
) {}
