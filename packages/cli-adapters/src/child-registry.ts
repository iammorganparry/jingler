import { execFile, type ChildProcess, type ExecFileOptionsWithStringEncoding } from "node:child_process"

export interface ChildOwner {
  readonly sessionId: string
  readonly action: string
}

interface ChildRecord {
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
  live.set(proc, { processGroup, ...(owner ? { owner } : {}) })
  const forget = () => live.delete(proc)
  if (processGroup) {
    // The leader can exit before a descendant. Kill the remaining owned group
    // while the process-group id is still known, then forget after stdio closes.
    proc.once("exit", () => signal(proc, "SIGKILL"))
    proc.once("close", forget)
  } else proc.once("exit", forget)
  proc.once("error", forget)
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

const waitForProcessGroupExit = async (proc: ChildProcess): Promise<void> => {
  if (!live.get(proc)?.processGroup || process.platform === "win32" || !proc.pid) return
  while (true) {
    try {
      process.kill(-proc.pid, 0)
      await new Promise((resolve) => setTimeout(resolve, 25))
    } catch {
      return
    }
  }
}

export const stopChildAndWait = async (
  proc: ChildProcess,
  graceMs: number = GRACE_MS,
  timeoutMs: number = graceMs + 3_000
): Promise<void> => {
  if (!isAlive(proc)) {
    stopChild(proc, graceMs)
    return
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out stopping child process ${proc.pid ?? "unknown"}.`)), timeoutMs)
    timeout.unref?.()
    const done = () => {
      void waitForProcessGroupExit(proc).then(() => {
        clearTimeout(timeout)
        resolve()
      }, reject)
    }
    proc.once("exit", done)
    proc.once("error", done)
    stopChild(proc, graceMs)
  })
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
  live.clear()
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
