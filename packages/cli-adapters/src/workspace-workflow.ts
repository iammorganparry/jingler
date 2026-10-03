import { spawn, type ChildProcess } from "node:child_process"
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { dirname, resolve, sep } from "node:path"
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
import { workspaceProcessEnvironment } from "./workspace-ports.js"

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
  lifecycleOwner?: symbol
): Promise<{ exitCode: number; output: string }> => {
  if (!session.worktreePath) throw new Error("Workspace checkout is unavailable.")
  const shell = shellCommand(command)
  const lease = lifecycleOwner
    ? acquireWorkspaceLifecycleActivity(session.id, action, lifecycleOwner)
    : acquireWorkspaceActivity(session.id, action)
  let ownedChild: ChildProcess | undefined
  try {
    const child = trackChild(spawn(shell.file, shell.args, {
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
      const timeout = setTimeout(() => {
        void stopOwnedChildren(session.id, action).then(() => reject(new Error("Workspace command timed out.")), reject)
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
    await stopChildAndWait(child, 0)
    return result
  } finally {
    if (ownedChild) await stopChildAndWait(ownedChild, 0)
    else lease.release()
  }
}

const isIgnored = (root: string, relative: string): Promise<boolean> =>
  new Promise((resolveIgnored, reject) => {
    const child = spawn("git", ["-C", root, "check-ignore", "--quiet", "--", relative], { stdio: "ignore" })
    child.once("error", reject)
    child.once("exit", (code) => resolveIgnored(code === 0))
  })

const validateCopyParents = (base: string, path: string, create: boolean) => {
    let current = base
    for (const part of path.slice(base.length + 1).split(sep).filter(Boolean)) {
      current = resolve(current, part)
      try {
        const info = lstatSync(current)
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe copied-file ancestor: ${path}`)
      } catch (cause) {
        if (!create || (cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
        mkdirSync(current, { mode: 0o700 })
      }
      if (realpathSync(current) !== current) throw new Error(`Copied-file ancestor changed: ${path}`)
    }
  }

const validateCopyTarget = (targetPath: string) => {
    try {
      const info = lstatSync(targetPath)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`Unsafe copied-file destination: ${targetPath}`)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
    }
  }

const removeCopyTemporary = (temporary: string) => {
  try { unlinkSync(temporary) } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
  }
}

export const copyApprovedFile = async (root: string, targetRoot: string, configured: string): Promise<void> => {
  const relative = safeWorkflowRelativePath(configured)
  if (!relative) throw new Error(`Unsafe copied-file path: ${configured}`)
  if (!(await isIgnored(root, relative))) throw new Error(`Copied file is not ignored by Git: ${relative}`)
  // Keep validation and writes synchronous: no app task can mutate ancestors between them.
  // O_NOFOLLOW protects the source inode; rename replaces the destination entry atomically.
  const realRoot = realpathSync(root)
  const realTargetRoot = realpathSync(targetRoot)
  const sourcePath = resolve(realRoot, relative)
  const targetPath = resolve(realTargetRoot, relative)
  validateCopyParents(realRoot, dirname(sourcePath), false)
  validateCopyParents(realTargetRoot, dirname(targetPath), true)
  validateCopyTarget(targetPath)
  const input = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  const temporary = resolve(dirname(targetPath), `.jingler-copy-${randomUUID()}`)
  let output: number | undefined
  try {
    const info = fstatSync(input)
    const limit = 16 * 1024 * 1024
    if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw new Error(`Copied file is unsafe or exceeds 16 MiB: ${relative}`)
    output = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    const buffer = Buffer.alloc(64 * 1024)
    let total = 0
    while (true) {
      const count = readSync(input, buffer, 0, buffer.length, null)
      if (count === 0) break
      total += count
      if (total > limit) throw new Error(`Copied file exceeds 16 MiB: ${relative}`)
      let written = 0
      while (written < count) written += writeSync(output, buffer, written, count - written)
    }
    fsyncSync(output)
    closeSync(output)
    output = undefined
    validateCopyParents(realTargetRoot, dirname(targetPath), false)
    validateCopyTarget(targetPath)
    renameSync(temporary, targetPath)
  } finally {
    closeSync(input)
    if (output !== undefined) closeSync(output)
    removeCopyTemporary(temporary)
  }
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
        Effect.mapError((cause) => new GitError({ message: cause instanceof Error ? cause.message : "Workspace setup failed", cause })),
        Effect.provide(env)
      )
      }

      const skipSetup = (sessionId: string) =>
        Effect.gen(function* () {
          if (operations.has(sessionId)) return yield* Effect.fail(new GitError({ message: "Workspace lifecycle operation is already in progress." }))
          if (workspaceActivityCount(sessionId) > 0) return yield* Effect.fail(new GitError({ message: "Workspace activity is still stopping." }))
          operations.add(sessionId)
          yield* Effect.addFinalizer(() => Effect.sync(() => operations.delete(sessionId)))
          const session = yield* sessions.get(sessionId).pipe(Effect.mapError((cause) => new GitError({ message: "Could not reload workspace", cause })))
          if (session.workspaceLifecycle?.status === "setup-running") {
            return yield* Effect.fail(new GitError({ message: "Cannot skip setup while it is running." }))
          }
          const closure = yield* Effect.try({
            try: () => setupClosures.get(sessionId) ?? closeWorkspaceAdmission(sessionId, "workspace setup is incomplete"),
            catch: (cause) => new GitError({ message: cause instanceof Error ? cause.message : "Workspace is unavailable", cause })
          })
          const lease = yield* Effect.try({
            try: () => acquireWorkspaceLifecycleActivity(sessionId, "skip-setup", closure),
            catch: (cause) => new GitError({ message: "Workspace setup ownership changed", cause })
          })
          yield* Effect.addFinalizer(() => Effect.sync(() => lease.release()))
          yield* lifecycle(sessionId, "setup-skipped")
          if (!reopenWorkspaceAdmission(sessionId, closure)) {
            return yield* Effect.fail(new GitError({ message: "Workspace ownership changed while setup was being skipped." }))
          }
          setupClosures.delete(sessionId)
          return yield* sessions.get(sessionId).pipe(
            Effect.mapError((cause) => new GitError({ message: "Could not reload workspace", cause }))
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
        catch: (cause) => new GitError({ message: cause instanceof Error ? cause.message : "Workspace is unavailable", cause })
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
        Effect.mapError((cause) => new GitError({ message: cause instanceof Error ? cause.message : "Workspace cleanup failed", cause })),
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
          } finally { pendingRuns.delete(key) }
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

      return { setup, skipSetup, prepareLifecycle, cleanup, startRun, stopRun, stopAll, listRuns }
    })
  }
) {}
