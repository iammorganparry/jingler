import { describe, expect, it, vi } from "vitest"
import type { ExpoSessionInput } from "./contracts.js"
import {
  ExpoPreviewController,
  parseSimulatorDevices,
  type ExpoRuntimeDependencies,
  type ManagedProcess,
  type ProcessListeners
} from "./runtime.js"

const PNG_BASE64 = Buffer.from("png-frame").toString("base64")
const ESCAPE = String.fromCharCode(27)

const SESSION: ExpoSessionInput = {
  sessionId: "session-1",
  worktreePath: "/repo/app"
}

const SIMCTL = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
      { udid: "booted-1", name: "iPhone 16", state: "Booted", isAvailable: true },
      { udid: "off-1", name: "iPhone SE", state: "Shutdown", isAvailable: true },
      { udid: "old-1", name: "Old iPhone", state: "Shutdown", isAvailable: false }
    ]
  }
})

interface Harness {
  readonly controller: ExpoPreviewController
  readonly deps: ExpoRuntimeDependencies
  readonly process: ManagedProcess
  readonly listeners: () => ProcessListeners
}

const harness = (overrides: Partial<ExpoRuntimeDependencies> = {}): Harness => {
  let processListeners: ProcessListeners | undefined
  const process: ManagedProcess = {
    write: vi.fn(async () => undefined),
    terminate: vi.fn(async () => {})
  }
  const deps: ExpoRuntimeDependencies = {
    platform: "darwin",
    exists: vi.fn(async () => true),
    exec: vi.fn(async () => ({ code: 0, stdout: SIMCTL, stderr: "" })),
    spawn: vi.fn(async (_executable, _args, _cwd, listeners) => {
      processListeners = listeners
      return process
    }),
    capture: vi.fn(async () => PNG_BASE64),
    openSimulator: vi.fn(async () => {}),
    now: () => 1234,
    ...overrides
  }
  return {
    controller: new ExpoPreviewController(deps),
    deps,
    process,
    listeners: () => {
      if (!processListeners) throw new Error("process was not spawned")
      return processListeners
    }
  }
}

describe("parseSimulatorDevices", () => {
  it("keeps available devices and their typed identity", () => {
    expect(parseSimulatorDevices(SIMCTL)).toEqual([
      { udid: "booted-1", name: "iPhone 16", state: "Booted" },
      { udid: "off-1", name: "iPhone SE", state: "Shutdown" }
    ])
  })

  it("rejects malformed simctl output", () => {
    expect(() => parseSimulatorDevices("not json")).toThrow("invalid Simulator device data")
    expect(() => parseSimulatorDevices("{}")).toThrow("invalid Simulator device data")
  })
})

describe("ExpoPreviewController prerequisites", () => {
  it("reports unsupported platforms without probing the worktree", async () => {
    const h = harness({ platform: "linux" })
    await expect(h.controller.inspect(SESSION)).resolves.toEqual({
      ready: false,
      reason: "Expo iOS Preview currently requires macOS and Xcode Simulator."
    })
    expect(h.deps.exists).not.toHaveBeenCalled()
  })

  it("reports a missing local Expo install without downloading one", async () => {
    const h = harness({ exists: vi.fn(async () => false) })
    const result = await h.controller.inspect(SESSION)
    expect(result.ready).toBe(false)
    expect(result.reason).toContain("not installed in this worktree")
    expect(h.deps.spawn).not.toHaveBeenCalled()
  })

  it("rejects an ambiguous set of booted simulators", async () => {
    const ambiguous = JSON.stringify({
      devices: {
        ios: [
          { udid: "sim-1", name: "iPhone 16", state: "Booted", isAvailable: true },
          { udid: "sim-2", name: "iPhone SE", state: "Booted", isAvailable: true }
        ]
      }
    })
    const h = harness({
      exec: vi.fn(async () => ({ code: 0, stdout: ambiguous, stderr: "" }))
    })

    await expect(h.controller.inspect(SESSION)).resolves.toMatchObject({
      ready: false,
      reason: expect.stringContaining("More than one")
    })
  })

  it("turns an xcrun failure into Xcode setup guidance", async () => {
    const h = harness({
      exec: vi.fn(async () => ({ code: 1, stdout: "", stderr: "xcrun: error" }))
    })
    const result = await h.controller.inspect(SESSION)
    expect(result).toEqual({
      ready: false,
      reason: "Xcode Simulator tools are unavailable. Install Xcode, open it once, and retry."
    })
  })
})

describe("ExpoPreviewController lifecycle", () => {
  it("starts the worktree-local CLI and becomes running from Expo output", async () => {
    const h = harness()
    const starting = await h.controller.start(SESSION)
    expect(starting.phase).toBe("starting")
    expect(h.deps.spawn).toHaveBeenCalledWith(
      "/repo/app/node_modules/.bin/expo",
      ["start", "--ios"],
      "/repo/app",
      expect.any(Object)
    )

    h.listeners().output(
      `${ESCAPE}[32mMetro waiting on exp://localhost:8081${ESCAPE}[0m\n/repo/app/App.tsx`
    )
    const running = await h.controller.status(SESSION)
    expect(running.phase).toBe("running")
    expect(running.logs).toEqual([
      "Metro waiting on exp://localhost:8081",
      "<worktree>/App.tsx"
    ])
  })

  it("reloads over stdin and stops only the owned process", async () => {
    const h = harness()
    await h.controller.start(SESSION)
    await h.controller.reload(SESSION)
    expect(h.process.write).toHaveBeenCalledWith("r\n")

    const stopped = await h.controller.stop(SESSION)
    expect(h.process.terminate).toHaveBeenCalledOnce()
    expect(stopped.phase).toBe("stopped")
  })

  it("reports stdin failures when Expo closes during reload", async () => {
    const h = harness()
    await h.controller.start(SESSION)
    vi.mocked(h.process.write).mockRejectedValueOnce(new Error("write EPIPE"))

    await expect(h.controller.reload(SESSION)).rejects.toThrow("EPIPE")
  })

  it("refuses a second session while the simulator preview is owned", async () => {
    const h = harness()
    await h.controller.start(SESSION)
    await expect(
      h.controller.start({ sessionId: "session-2", worktreePath: "/repo/two" })
    ).rejects.toThrow("Another session already owns")
  })

  it("releases ownership after stop and bounds retained output", async () => {
    const h = harness()
    await h.controller.start(SESSION)
    for (let index = 0; index < 110; index += 1) {
      h.listeners().output(`/repo/app/log-${index}\n`)
    }
    expect((await h.controller.status(SESSION)).logs).toHaveLength(100)

    await h.controller.stop(SESSION)
    const second = { sessionId: "session-2", worktreePath: "/repo/two" }
    await expect(h.controller.start(second)).resolves.toMatchObject({
      phase: "starting",
      sessionId: "session-2"
    })
    expect((await h.controller.status(SESSION)).phase).toBe("idle")
  })

  it("serializes concurrent starts so only one process is launched", async () => {
    const h = harness()

    await Promise.all([h.controller.start(SESSION), h.controller.start(SESSION)])

    expect(h.deps.spawn).toHaveBeenCalledOnce()
  })

  it("terminates a process when stop arrives while spawn is pending", async () => {
    let release: ((process: ManagedProcess) => void) | undefined
    const h = harness({
      spawn: vi.fn((_executable, _args, _cwd, listeners) => {
        return new Promise<ManagedProcess>((resolve) => {
          release = resolve
          Object.assign(h, { listeners: () => listeners })
        })
      })
    })
    const started = h.controller.start(SESSION)
    await vi.waitFor(() => expect(h.deps.spawn).toHaveBeenCalledOnce())
    const stopped = h.controller.stop(SESSION)
    release?.(h.process)

    await started
    await stopped
    expect(h.process.terminate).toHaveBeenCalledOnce()
  })

  it("ignores exit callbacks from a stopped generation", async () => {
    const h = harness()
    await h.controller.start(SESSION)
    const oldListeners = h.listeners()
    await h.controller.stop(SESSION)
    const second = { sessionId: "session-2", worktreePath: "/repo/two" }
    await h.controller.start(second)

    oldListeners.exit(7, null)

    expect((await h.controller.status(second)).phase).toBe("starting")
  })

  it("records an unexpected process exit and cleans up on dispose", async () => {
    const h = harness()
    await h.controller.start(SESSION)
    h.listeners().exit(7, null)
    const failed = await h.controller.status(SESSION)
    expect(failed.phase).toBe("failed")
    expect(failed.error).toBe("Expo exited with code 7.")

    const active = harness()
    await active.controller.start(SESSION)
    await active.controller.dispose()
    expect(active.process.terminate).toHaveBeenCalledOnce()
  })
})

describe("ExpoPreviewController frames", () => {
  it("captures the selected simulator without treating a screenshot as Expo readiness", async () => {
    const h = harness()
    await h.controller.start(SESSION)
    await expect(h.controller.frame(SESSION)).resolves.toEqual({
      pngBase64: PNG_BASE64,
      capturedAt: 1234,
      device: { udid: "booted-1", name: "iPhone 16", state: "Booted" }
    })
    expect(h.deps.capture).toHaveBeenCalledWith("booted-1")
    expect((await h.controller.status(SESSION)).phase).toBe("starting")
  })

  it("does not reuse a stale capture after stop and owner replacement", async () => {
    let releaseFirst: ((value: string) => void) | undefined
    const capture = vi.fn()
      .mockImplementationOnce(() => new Promise<string>((resolve) => { releaseFirst = resolve }))
      .mockResolvedValueOnce(PNG_BASE64)
    const h = harness({ capture })
    await h.controller.start(SESSION)
    const stale = h.controller.frame(SESSION)
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce())
    await h.controller.stop(SESSION)
    const second = { sessionId: "session-2", worktreePath: "/repo/two" }
    await h.controller.start(second)
    const staleResult = expect(stale).rejects.toThrow("preview changed")
    releaseFirst?.(PNG_BASE64)

    await staleResult
    await expect(h.controller.frame(second)).resolves.toMatchObject({ pngBase64: PNG_BASE64 })
    expect(capture).toHaveBeenCalledTimes(2)
  })

  it("coalesces overlapping screenshot requests", async () => {
    let release: ((value: string) => void) | undefined
    const capture = vi.fn(
      () => new Promise<string>((resolve) => {
        release = resolve
      })
    )
    const h = harness({ capture })
    await h.controller.start(SESSION)
    const first = h.controller.frame(SESSION)
    const second = h.controller.frame(SESSION)
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce())
    release?.(PNG_BASE64)
    await Promise.all([first, second])
    expect(capture).toHaveBeenCalledOnce()
  })
})
