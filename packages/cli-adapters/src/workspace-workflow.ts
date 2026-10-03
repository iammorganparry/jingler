import { spawn, type ChildProcess } from "node:child_process"
import { copyFile, lstat, mkdir, realpath } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"
import type { FileSystem, Path, CommandExecutor } from "@effect/platform"
import { GitError, type Session, type WorkspaceRunState } from "@jingler/core"
import { Effect } from "effect"
import type { AppPaths } from "./app-paths.js"
import { trackChild, stopOwnedChildren } from "./child-registry.js"
import { approvedWorkflow, safeWorkflowRelativePath } from "./project-workflow.js"
import { ProjectService } from "./projects.js"
import { SessionStore } from "./sessions.js"
import {
  acquireWorkspaceActivity,
  acquireWorkspaceLifecycleActivity,
  closeWorkspaceAdmission,
  reopenWorkspaceAdmission
} from "./workspace-admission.js"
import { worktreeEnv } from "./worktree-env.js"

const OUTPUT_LIMIT = 64 * 1024
const COMMAND_TIMEOUT_MS = 10 * 60_000

interface LiveRun {
  readonly state: WorkspaceRunState
  readonly child: ChildProcess
}

const safeOutput = (value: string): string =>
  value
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)\S+/giu, "$1[redacted]")
    .slice(-OUTPUT_LIMIT)

const shellCommand = (command: string): { file: string; args: string[] } => {
  if (process.platform === "win32") {
    throw new Error("Workspace commands are not supported on Windows until owned process-tree termination is available.")
  }
  return { file: process.env.SHELL || "/bin/sh", args: ["-lc", command] }
}

const runCommand = async (
  session: Session,
  action: string,
  command: string,
  onSpawn?: (child: ChildProcess) => void,
  lifecycleOwner = false
): Promise<{ exitCode: number; output: string }> => {
  if (!session.worktreePath) throw new Error("Workspace checkout is unavailable.")
  const shell = shellCommand(command)
  const lease = lifecycleOwner
    ? acquireWorkspaceLifecycleActivity(session.id, action)
    : acquireWorkspaceActivity(session.id, action)
  try {
    const child = trackChild(spawn(shell.file, shell.args, {
      cwd: session.worktreePath,
      env: worktreeEnv(process.env, session.worktreePath),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    }), true, { sessionId: session.id, action })
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
      const timeout = setTimeout(() => {
        void stopOwnedChildren(session.id, action).finally(() => reject(new Error("Workspace command timed out.")))
      }, COMMAND_TIMEOUT_MS)
      timeout.unref?.()
      child.once("error", (cause) => {
        clearTimeout(timeout)
        reject(cause)
      })
      child.once("exit", (code) => {
        clearTimeout(timeout)
        resolveResult({ exitCode: code ?? 1, output: safeOutput(output) })
      })
    })
    return result
  } finally {
    lease.release()
  }
}

const isIgnored = (root: string, relative: string): Promise<boolean> =>
  new Promise((resolveIgnored, reject) => {
    const child = spawn("git", ["-C", root, "check-ignore", "--quiet", "--", relative], { stdio: "ignore" })
    child.once("error", reject)
    child.once("exit", (code) => resolveIgnored(code === 0))
  })

const copyApprovedFile = async (root: string, targetRoot: string, configured: string): Promise<void> => {
  const relative = safeWorkflowRelativePath(configured)
  if (!relative) throw new Error(`Unsafe copied-file path: ${configured}`)
  if (!(await isIgnored(root, relative))) throw new Error(`Copied file is not ignored by Git: ${relative}`)
  const source = resolve(root, relative)
  const target = resolve(targetRoot, relative)
  const [realRoot, realTargetRoot, sourceInfo] = await Promise.all([realpath(root), realpath(targetRoot), lstat(source)])
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) throw new Error(`Copied file must be a regular file: ${relative}`)
  const realSource = await realpath(source)
  if (!realSource.startsWith(`${realRoot}${sep}`)) throw new Error(`Copied file escapes the project: ${relative}`)
  if (!target.startsWith(`${resolve(targetRoot)}${sep}`)) throw new Error(`Copied file escapes the workspace: ${relative}`)
  let ancestor = dirname(target)
  while (true) {
    try { await lstat(ancestor); break } catch {
      const parent = dirname(ancestor)
      if (parent === ancestor) throw new Error(`Could not validate copied-file destination: ${relative}`)
      ancestor = parent
    }
  }
  const realAncestor = await realpath(ancestor)
  if (realAncestor !== realTargetRoot && !realAncestor.startsWith(`${realTargetRoot}${sep}`)) {
    throw new Error(`Copied file destination escapes the workspace: ${relative}`)
  }
  try {
    const targetInfo = await lstat(target)
    if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) throw new Error(`Copied file destination is not a regular file: ${relative}`)
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause
  }
  await mkdir(dirname(target), { recursive: true })
  await copyFile(realSource, target)
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
      const runs = new Map<string, Map<string, LiveRun>>()
      const setupClosures = new Map<string, symbol>()

      const lifecycle = (sessionId: string, status: NonNullable<Session["workspaceLifecycle"]>["status"], extra: { error?: string; output?: string } = {}) =>
        sessions.setWorkspaceLifecycle(sessionId, {
          status,
          updatedAt: new Date().toISOString(),
          ...extra
        })

      const setup = (sessionId: string) => Effect.tryPromise({
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: setup deliberately keeps approval, copy, command, persistence, and admission in one failure boundary.
        try: async () => {
          const session = await runEffect(sessions.get(sessionId))
          if (session.environmentId || session.workspaceMode === "direct" || !session.projectId) {
            await runEffect(lifecycle(sessionId, "ready"))
            return await runEffect(sessions.get(sessionId))
          }
          const closure = closeWorkspaceAdmission(sessionId, "workspace setup is incomplete")
          setupClosures.set(sessionId, closure)
          await runEffect(lifecycle(sessionId, "setup-running"))
          const project = await runEffect(projects.get(session.projectId))
          const workflow = approvedWorkflow(project.workflow)
          if (project.workflow && !workflow) throw new Error("Project workflow changed and needs operator approval.")
          if (workflow) {
            for (const file of workflow.copyFiles) await copyApprovedFile(project.path, session.worktreePath!, file)
            if (workflow.setup) {
              const result = await runCommand(session, "setup", workflow.setup, undefined, true)
              if (result.exitCode !== 0) throw Object.assign(new Error(`Setup exited with code ${result.exitCode}.`), { output: result.output })
            }
          }
          await runEffect(lifecycle(sessionId, "ready"))
          if (reopenWorkspaceAdmission(sessionId, closure)) setupClosures.delete(sessionId)
          return await runEffect(sessions.get(sessionId))
        },
        catch: (cause) => cause
      }).pipe(
        Effect.tapError((cause) => lifecycle(sessionId, "setup-failed", {
          error: cause instanceof Error ? cause.message : String(cause),
          ...((cause as { output?: unknown })?.output && typeof (cause as { output?: unknown }).output === "string"
            ? { output: (cause as { output: string }).output }
            : {})
        }).pipe(Effect.ignore)),
        Effect.mapError((cause) => new GitError({ message: cause instanceof Error ? cause.message : "Workspace setup failed", cause }))
      )

      const skipSetup = (sessionId: string) =>
        Effect.gen(function* () {
          const closure = yield* Effect.try({
            try: () => setupClosures.get(sessionId) ?? closeWorkspaceAdmission(sessionId, "workspace setup is incomplete"),
            catch: (cause) => new GitError({ message: cause instanceof Error ? cause.message : "Workspace is unavailable", cause })
          })
          yield* lifecycle(sessionId, "setup-skipped")
          if (!reopenWorkspaceAdmission(sessionId, closure)) {
            return yield* Effect.fail(new GitError({ message: "Workspace ownership changed while setup was being skipped." }))
          }
          setupClosures.delete(sessionId)
          return yield* sessions.get(sessionId).pipe(
            Effect.mapError((cause) => new GitError({ message: "Could not reload workspace", cause }))
          )
        })

      const cleanup = (sessionId: string) => Effect.tryPromise({
        try: async () => {
          const session = await runEffect(sessions.get(sessionId))
          await runEffect(lifecycle(sessionId, "cleanup-running"))
          if (!session.projectId) return
          const project = await runEffect(projects.get(session.projectId))
          const workflow = approvedWorkflow(project.workflow)
          if (project.workflow && !workflow) throw new Error("Project workflow changed and needs operator approval before cleanup.")
          if (workflow?.cleanup) {
            const result = await runCommand(session, "cleanup", workflow.cleanup, undefined, true)
            if (result.exitCode !== 0) throw Object.assign(new Error(`Cleanup exited with code ${result.exitCode}.`), { output: result.output })
          }
        },
        catch: (cause) => cause
      }).pipe(
        Effect.tapError((cause) => lifecycle(sessionId, "cleanup-failed", {
          error: cause instanceof Error ? cause.message : String(cause),
          ...((cause as { output?: unknown })?.output && typeof (cause as { output?: unknown }).output === "string"
            ? { output: (cause as { output: string }).output }
            : {})
        }).pipe(Effect.ignore)),
        Effect.mapError((cause) => new GitError({ message: cause instanceof Error ? cause.message : "Workspace cleanup failed", cause }))
      )

      const startRun = (sessionId: string, runId: string) => Effect.tryPromise({
        try: async () => {
          const session = await runEffect(sessions.get(sessionId))
          if (!session.projectId || session.workspaceLifecycle?.status !== "ready" && session.workspaceLifecycle?.status !== "setup-skipped") {
            throw new Error("Workspace setup must finish before running project commands.")
          }
          const project = await runEffect(projects.get(session.projectId))
          const workflow = approvedWorkflow(project.workflow)
          if (!workflow) throw new Error("Project workflow needs operator approval.")
          const command = workflow.runs.find((candidate) => candidate.id === runId)
          if (!command) throw new Error("Unknown project run command.")
          const sessionRuns = runs.get(sessionId) ?? new Map<string, LiveRun>()
          if (sessionRuns.get(runId)?.state.status === "running") throw new Error(`${command.label} is already running.`)
          const startedAt = new Date().toISOString()
          const state: WorkspaceRunState = { id: runId, label: command.label, status: "running", startedAt }
          let resolveSpawn!: () => void
          let rejectSpawn!: (cause: unknown) => void
          const spawned = new Promise<void>((resolve, reject) => { resolveSpawn = resolve; rejectSpawn = reject })
          const resultPromise = runCommand(session, `run:${runId}`, command.command, (child) => {
            sessionRuns.set(runId, { state, child })
            runs.set(sessionId, sessionRuns)
            resolveSpawn()
          })
          void resultPromise.catch(rejectSpawn)
          await spawned
          void resultPromise.then((result) => {
            sessionRuns.set(runId, {
              state: {
                ...state,
                status: result.exitCode === 0 ? "exited" : "failed",
                exitCode: result.exitCode,
                ...(result.output ? { output: result.output } : {})
              },
              child: sessionRuns.get(runId)!.child
            })
          }).catch((cause) => {
            const current = sessionRuns.get(runId)
            if (current) sessionRuns.set(runId, { ...current, state: { ...state, status: "failed", output: safeOutput(cause instanceof Error ? cause.message : String(cause)) } })
          })
          return state
        },
        catch: (cause) => new GitError({ message: cause instanceof Error ? cause.message : "Could not run project command", cause })
      })

      const stopRun = (sessionId: string, runId: string) =>
        Effect.tryPromise({
          try: async () => { await stopOwnedChildren(sessionId, `run:${runId}`) },
          catch: (cause) => new GitError({ message: "Could not stop project command", cause })
        })

      const stopAll = (sessionId: string) => Effect.tryPromise({
        try: async () => { await stopOwnedChildren(sessionId) },
        catch: (cause) => new GitError({ message: "Could not stop workspace commands", cause })
      })

      const listRuns = (sessionId: string): Effect.Effect<ReadonlyArray<WorkspaceRunState>> =>
        Effect.sync(() => [...(runs.get(sessionId)?.values() ?? [])].map(({ state }) => state))

      return { setup, skipSetup, cleanup, startRun, stopRun, stopAll, listRuns }
    })
  }
) {}
