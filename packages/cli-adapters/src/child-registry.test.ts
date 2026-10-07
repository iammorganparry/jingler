import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { afterEach, describe, expect, it, vi } from "vitest"
import { killAllChildren, liveChildCount, ownedChildCount, stopChild, stopChildAndWait, stopOwnedChildren, trackChild } from "./child-registry.js"

/**
 * The orphan guard. A harness subprocess that outlives the app is invisible,
 * holds a port, and accumulates one per launch — under the e2e suite that meant
 * one leaked `opencode serve` per test until the machine was cleared by hand.
 */

/** A child that ignores SIGTERM, standing in for a server that won't go quietly. */
const stubborn = (): ChildProcess =>
  trackChild(
    spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
      stdio: "ignore"
    })
  )

/** A child that exits on SIGTERM, like a well-behaved server. */
const polite = (): ChildProcess =>
  trackChild(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }))

const exited = (proc: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
    proc.once("exit", () => resolve())
  })

const isRunning = (proc: ChildProcess): boolean => {
  if (proc.pid === undefined) return false
  try {
    // Signal 0 tests for existence without delivering anything.
    process.kill(proc.pid, 0)
    return true
  } catch {
    return false
  }
}

afterEach(async () => {
  // Never let a test leak the very thing this module exists to prevent.
  killAllChildren()
  await expect.poll(() => liveChildCount()).toBe(0)
})

describe("trackChild", () => {
  it("registers a spawned child", () => {
    const before = liveChildCount()
    polite()
    expect(liveChildCount()).toBe(before + 1)
  })

  it("deregisters it once it exits, so the set can't grow forever", async () => {
    const before = liveChildCount()
    const proc = polite()
    proc.kill("SIGKILL")
    await exited(proc)
    // The 'exit' listener runs on the same tick as the event.
    expect(liveChildCount()).toBe(before)
  })

  it("returns the same child, so it can wrap a spawn call directly", () => {
    const proc = polite()
    expect(typeof proc.pid).toBe("number")
  })
})

describe("stopChild", () => {
  it("stops a child that honours SIGTERM", async () => {
    const proc = polite()
    stopChild(proc)
    await exited(proc)
    expect(isRunning(proc)).toBe(false)
  })

  /**
   * The reason SIGTERM alone was not enough. opencode is a compiled Bun binary and
   * codex an app-server; neither is obliged to honour a polite request, and an
   * unheeded SIGTERM leaves exactly the process we were trying to reap.
   */
  it("escalates to SIGKILL for a child that ignores SIGTERM", async () => {
    const proc = stubborn()
    // Give it a moment to install its SIGTERM handler before we signal.
    await new Promise((r) => setTimeout(r, 200))
    stopChild(proc, 300)
    await exited(proc)
    expect(proc.signalCode).toBe("SIGKILL")
    expect(isRunning(proc)).toBe(false)
  }, 10_000)

  it("is a no-op for a child that has already exited", async () => {
    const proc = polite()
    proc.kill("SIGKILL")
    await exited(proc)
    expect(() => stopChild(proc)).not.toThrow()
  })
})

describe("owned children", () => {
  it("awaits only the selected session's process tree", async () => {
    const first = trackChild(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }), false, { sessionId: "s-1", action: "run:dev" })
    const second = trackChild(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }), false, { sessionId: "s-2", action: "run:dev" })
    expect(ownedChildCount("s-1")).toBe(1)
    await stopOwnedChildren("s-1")
    expect(isRunning(first)).toBe(false)
    expect(isRunning(second)).toBe(true)
  })
})

describe("killAllChildren", () => {
  /** The quit path: everything still running dies, politely or otherwise. */
  it("kills every tracked child, including ones ignoring SIGTERM", async () => {
    const a = polite()
    const b = stubborn()
    await new Promise((r) => setTimeout(r, 200))

    const killed = killAllChildren()
    expect(killed).toBeGreaterThanOrEqual(2)

    await Promise.all([exited(a), exited(b)])
    expect(isRunning(a)).toBe(false)
    expect(isRunning(b)).toBe(false)
  }, 10_000)

  it("empties the registry after processes have actually stopped", async () => {
    polite()
    stubborn()
    killAllChildren()
    await expect.poll(() => liveChildCount()).toBe(0)
  })

  it("reports zero and does nothing when there is nothing to kill", async () => {
    killAllChildren()
    await expect.poll(() => liveChildCount()).toBe(0)
    expect(killAllChildren()).toBe(0)
  })

  /**
   * The e2e shape: a child spawned and then abandoned mid-flight, exactly as when
   * the app quits while the model catalogue is still being fetched. Nothing else
   * in the process holds a reference to it — the registry is the only way back.
   */
  it("reaps a child nobody kept a reference to", async () => {
    const pid = (() => {
      const orphan = stubborn()
      return orphan.pid
    })()
    await new Promise((r) => setTimeout(r, 200))
    expect(pid).toBeDefined()

    killAllChildren()
    await new Promise((r) => setTimeout(r, 500))

    let alive = true
    try {
      process.kill(pid!, 0)
    } catch {
      alive = false
    }
    expect(alive).toBe(false)
  }, 10_000)
})

// Exercise a real detached POSIX group, including a grandchild holding stdout open.
it.skipIf(process.platform === "win32")("awaits the whole owned process group before cleanup continues", async () => {
  const child = trackChild(spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process")
    const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] })
    console.log(descendant.pid)
    setInterval(() => {}, 1000)
  `], { detached: true, stdio: ["ignore", "pipe", "pipe"] }), true, { sessionId: "tree", action: "cleanup" })
  const descendantPid = await new Promise<number>((resolve) => child.stdout.once("data", (data) => resolve(Number(String(data).trim()))))
  await stopOwnedChildren("tree")
  expect(isRunning(child)).toBe(false)
  expect(() => process.kill(descendantPid, 0)).toThrow()
})

it.skipIf(process.platform === "win32")("reaps descendants when an owned process-group leader exits", async () => {
  const before = liveChildCount()
  const child = trackChild(spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process")
    const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] })
    console.log(descendant.pid)
    process.stdin.once("data", () => process.exit(0))
  `], { detached: true, stdio: ["pipe", "pipe", "pipe"] }), true)
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
  let descendantPid: number | undefined
  try {
    descendantPid = await new Promise<number>((resolve) => child.stdout.once("data", (data) => resolve(Number(String(data).trim()))))
    expect(descendantPid).toBeGreaterThan(0)
    process.kill(descendantPid, 0)
    child.stdin.write("exit")
    await closed
    await expect.poll(() => {
      try { process.kill(descendantPid!, 0); return true } catch { return false }
    }).toBe(false)
    await expect.poll(() => liveChildCount()).toBe(before)
  } finally {
    stopChild(child, 0)
    if (descendantPid) {
      try { process.kill(descendantPid, "SIGKILL") } catch { /* already reaped */ }
    }
  }
})

it.skipIf(process.platform === "win32")("bounds shutdown polling, retains ownership on timeout, and supports retry", async () => {
  const child = trackChild(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }), true, { sessionId: "timeout", action: "run" })
  try {
    // A negative timeout forces the bounded failure path before the leader can exit.
    await expect(stopChildAndWait(child, 10_000, -1)).rejects.toThrow(/Timed out/)
    expect(ownedChildCount("timeout")).toBe(1)
    await stopChildAndWait(child, 0)
    expect(ownedChildCount("timeout")).toBe(0)
  } finally {
    await stopChildAndWait(child, 0)
  }
})

describe.skipIf(process.platform === "win32")("process-group shutdown races", () => {
  it("waits through a transient EPERM until ESRCH proves the group disappeared", async () => {
    const child = trackChild(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }), true)
    await new Promise<void>((resolve) => child.once("spawn", resolve))
    const kill = process.kill.bind(process)
    let probes = 0
    const spy = vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
      if (pid === -child.pid! && sig === 0 && ++probes <= 2) {
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" })
      }
      return kill(pid, sig)
    })
    try {
      await stopChildAndWait(child, 0)
      expect(probes).toBeGreaterThan(2)
      expect(isRunning(child)).toBe(false)
    } finally { spy.mockRestore(); await stopChildAndWait(child, 0) }
  })

  it("retains ownership on persistent permission denial and retries without signaling foreign PIDs", async () => {
    const onStopped = vi.fn()
    const child = trackChild(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }), true, { sessionId: "denied", action: "run", onStopped })
    await new Promise<void>((resolve) => child.once("spawn", resolve))
    const refusal = Object.assign(new Error("kill EPERM"), { code: "EPERM" })
    const spy = vi.spyOn(process, "kill").mockImplementation(() => { throw refusal })
    let deadline: ReturnType<typeof setTimeout> | undefined
    let clock: ReturnType<typeof vi.spyOn> | undefined
    try {
      const first = stopChildAndWait(child, 0, 60)
      clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() - 60_000)
      expect(stopChildAndWait(child, 0, 60)).toBe(first)
      const stalled = new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("Shutdown exceeded its elapsed deadline")), 1000) })
      await expect(Promise.race([first, stalled])).rejects.toBe(refusal)
      expect(ownedChildCount("denied")).toBe(1)
      expect(onStopped).not.toHaveBeenCalled()
      expect(spy.mock.calls.every(([pid]) => pid === -child.pid!)).toBe(true)
    } finally { clearTimeout(deadline); clock?.mockRestore(); spy.mockRestore(); await stopChildAndWait(child, 0) }
    expect(onStopped).toHaveBeenCalledTimes(1)
    const spyAfter = vi.spyOn(process, "kill")
    try { await stopChildAndWait(child, 0); expect(spyAfter).not.toHaveBeenCalled() }
    finally { spyAfter.mockRestore() }
  })

  it("releases failed spawns without probing or signaling a group", async () => {
    const onStopped = vi.fn()
    const child = trackChild(spawn("/nonexistent/jingler-owned-child", [], { detached: true, stdio: "ignore" }), true, { sessionId: "spawn-failed", action: "run", onStopped })
    const spy = vi.spyOn(process, "kill")
    try {
      await stopChildAndWait(child, 0)
      expect(ownedChildCount("spawn-failed")).toBe(0)
      expect(onStopped).toHaveBeenCalledTimes(1)
      expect(spy).not.toHaveBeenCalled()
    } finally { spy.mockRestore() }
  })

  it("retains ownership when group existence fails with an unknown error", async () => {
    const child = trackChild(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }), true, { sessionId: "unknown-group", action: "run" })
    await new Promise<void>((resolve) => child.once("spawn", resolve))
    const kill = process.kill.bind(process)
    const refusal = Object.assign(new Error("group probe failed"), { code: "EIO" })
    const spy = vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
      if (pid === -child.pid! && sig === 0) throw refusal
      return kill(pid, sig)
    })
    try {
      await expect(stopChildAndWait(child, 0)).rejects.toBe(refusal)
      expect(ownedChildCount("unknown-group")).toBe(1)
    } finally { spy.mockRestore(); await stopChildAndWait(child, 0) }
  })

  it("shares shutdown with the leader exit callback and notifies the owner once", async () => {
    const onStopped = vi.fn()
    const child = trackChild(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }), true, { sessionId: "concurrent", action: "run", onStopped })
    const stopped = stopChildAndWait(child, 0)
    expect(stopChildAndWait(child, 0)).toBe(stopped)
    await stopped
    expect(onStopped).toHaveBeenCalledTimes(1)
    expect(ownedChildCount("concurrent")).toBe(0)
  })
})
