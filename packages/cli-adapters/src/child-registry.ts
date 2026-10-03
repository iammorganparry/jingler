import { execFile, type ChildProcess, type ExecFileOptionsWithStringEncoding } from "node:child_process"

export interface ChildOwner {
  readonly sessionId: string
  readonly action: string
  readonly onStopped?: () => void
}

interface ChildRecord {
  spawned: boolean
  readonly processGroup: boolean
  readonly owner?: ChildOwner
}

/** Every owned subprocess, including detached groups started by workspace actions. */
const live = new Map<ChildProcess, ChildRecord>()
const GRACE_MS = 2_000

const isAlive = (proc: ChildProcess): boolean =>
  proc.pid !== undefined && proc.exitCode === null && proc.signalCode === null

const signal = (proc: ChildProcess, sig: NodeJS.Signals): void => {
  try {
    const record = live.get(proc)
    if (record?.processGroup && proc.pid && process.platform !== "win32") process.kill(-proc.pid, sig)
    else if (isAlive(proc)) proc.kill(sig)
  } catch {
    /* already gone */
  }
}

export const trackChild = <P extends ChildProcess>(
  proc: P,
  processGroup = false,
  owner?: ChildOwner
): P => {
  live.set(proc, { processGroup, spawned: false, ...(owner ? { owner } : {}) })
  proc.once("spawn", () => { const record = live.get(proc); if (record) record.spawned = true })
  if (processGroup) {
    proc.once("exit", () => { void stopChildAndWait(proc, 0).catch(() => { /* Retain ownership on timeout. */ }) })
    proc.once("error", () => {
      if (!proc.pid) { live.get(proc)?.owner?.onStopped?.(); live.delete(proc) }
    })
  } else {
    proc.once("exit", () => { live.get(proc)?.owner?.onStopped?.(); live.delete(proc) })
    proc.once("error", () => { live.get(proc)?.owner?.onStopped?.(); live.delete(proc) })
  }
  return proc
}

export const stopChild = (proc: ChildProcess, graceMs: number = GRACE_MS): void => {
  if (!isAlive(proc)) {
    if (live.get(proc)?.processGroup) signal(proc, "SIGKILL")
    return
  }
  signal(proc, "SIGTERM")
  const timer = setTimeout(() => signal(proc, "SIGKILL"), graceMs)
  timer.unref?.()
  proc.once("exit", () => clearTimeout(timer))
}

const groupAlive = (proc: ChildProcess): boolean => {
  if (!live.get(proc)?.processGroup) return isAlive(proc)
  if (!live.get(proc)?.spawned) return true
  if (process.platform === "win32") throw new Error("Owned process-group shutdown is unsupported on Windows.")
  if (!proc.pid) return isAlive(proc)
  try { process.kill(-proc.pid, 0); return true } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ESRCH") return false
    throw cause
  }
}

export const stopChildAndWait = async (
  proc: ChildProcess,
  graceMs: number = GRACE_MS,
  timeoutMs: number = graceMs + 3_000
): Promise<void> => {
  const started = Date.now()
  signal(proc, graceMs === 0 ? "SIGKILL" : "SIGTERM")
  while (groupAlive(proc)) {
    const elapsed = Date.now() - started
    if (elapsed >= timeoutMs) throw new Error(`Timed out stopping child process ${proc.pid ?? "unknown"}.`)
    if (elapsed >= graceMs) signal(proc, "SIGKILL")
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, timeoutMs - elapsed)))
  }
  live.get(proc)?.owner?.onStopped?.()
  live.delete(proc)
}

/** Stop only children provably owned by this live app/session. Persisted PIDs are never used. */
export const stopOwnedChildren = async (
  sessionId: string,
  action?: string,
  graceMs: number = GRACE_MS
): Promise<number> => {
  const matches = [...live.entries()].filter(([, record]) =>
    record.owner?.sessionId === sessionId && (action === undefined || record.owner.action === action)
  )
  await Promise.all(matches.map(([proc]) => stopChildAndWait(proc, graceMs)))
  return matches.length
}

export const killAllChildren = (): number => {
  let killed = 0
  for (const proc of live.keys()) {
    if (isAlive(proc)) killed += 1
    signal(proc, "SIGKILL")
  }
  for (const proc of live.keys()) {
    if (live.get(proc)?.processGroup) void stopChildAndWait(proc, 0).catch(() => { /* Retain timed-out ownership. */ })
  }
  return killed
}

export const execFileText = (
  file: string,
  args: readonly string[],
  options: Omit<ExecFileOptionsWithStringEncoding, "encoding"> = {}
): Promise<string> => new Promise((resolve, reject) => {
  trackChild(execFile(file, [...args], { ...options, encoding: "utf8" }, (error, stdout) =>
    error ? reject(error) : resolve(stdout)))
})

export const liveChildCount = (): number => live.size

export const ownedChildCount = (sessionId: string): number =>
  [...live.values()].filter((record) => record.owner?.sessionId === sessionId).length
