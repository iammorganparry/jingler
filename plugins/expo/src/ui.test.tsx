// @vitest-environment jsdom
import type { SessionSnapshot } from "@jingler/plugin-sdk"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ExpoFrame, ExpoStatus } from "./contracts.js"

const mocks = vi.hoisted(() => {
  const invoke = vi.fn()
  return {
    invoke,
    host: {
      invoke,
      openExternal: vi.fn(),
      storage: {},
      sessions: {}
    }
  }
})

vi.mock("@jingler/plugin-sdk", async (load) => {
  const actual = await load<typeof import("@jingler/plugin-sdk")>()
  return {
    ...actual,
    useHost: () => mocks.host
  }
})

import { ExpoTab } from "./ui.js"

const session: SessionSnapshot = {
  id: "session-1",
  repo: "acme/mobile",
  branch: "feat/preview",
  title: "Mobile app",
  prNumber: null,
  worktreePath: "/repo/mobile"
}

const ready: ExpoStatus = {
  ready: true,
  phase: "idle",
  logs: []
}

const running: ExpoStatus = {
  ready: true,
  phase: "running",
  sessionId: session.id,
  simulator: { udid: "sim-1", name: "iPhone 16", state: "Booted" },
  logs: ["Metro waiting on exp://localhost:8081"]
}

const frame: ExpoFrame = {
  pngBase64: Buffer.from("frame").toString("base64"),
  capturedAt: 1234,
  device: { udid: "sim-1", name: "iPhone 16", state: "Booted" }
}

beforeEach(() => {
  mocks.invoke.mockReset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("ExpoTab setup states", () => {
  it("shows an actionable prerequisite failure", async () => {
    mocks.invoke.mockResolvedValue({
      ready: false,
      reason: "Expo is not installed in this worktree.",
      phase: "idle",
      logs: []
    } satisfies ExpoStatus)

    render(<ExpoTab pluginId="expo" session={session} />)

    expect(await screen.findByText("Expo is not installed in this worktree.")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Retry check" })).toBeTruthy()
  })

  it("starts the preview from the ready state and disables the action in flight", async () => {
    let release: ((status: ExpoStatus) => void) | undefined
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "expo.status") return Promise.resolve(ready)
      if (command === "expo.start") {
        return new Promise<ExpoStatus>((resolve) => {
          release = resolve
        })
      }
      return Promise.reject(new Error(`Unexpected command ${command}`))
    })
    render(<ExpoTab pluginId="expo" session={session} />)

    const start = await screen.findByRole("button", { name: "Start iOS Preview" })
    fireEvent.click(start)
    expect(start).toHaveProperty("disabled", true)
    expect(mocks.invoke).toHaveBeenCalledWith("expo.start", {
      sessionId: "session-1",
      worktreePath: "/repo/mobile"
    })

    release?.({ ...running, phase: "failed", error: "Expo exited." })
    expect(await screen.findByText("Expo exited.")).toBeTruthy()
  })
})

describe("ExpoTab live preview", () => {
  it("renders a captured frame and wires the browser-like toolbar", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "expo.status") return Promise.resolve(running)
      if (command === "expo.frame") return Promise.resolve(frame)
      if (command === "expo.reload") return Promise.resolve(running)
      if (command === "expo.open-simulator") return Promise.resolve(undefined)
      if (command === "expo.stop") return Promise.resolve({ ...ready, phase: "stopped" })
      return Promise.reject(new Error(`Unexpected command ${command}`))
    })
    render(<ExpoTab pluginId="expo" session={session} />)

    const image = await screen.findByRole("img", { name: "iPhone 16 screen" })
    expect(image.getAttribute("src")).toBe(`data:image/png;base64,${frame.pngBase64}`)

    fireEvent.click(screen.getByRole("button", { name: "Reload Expo app" }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("expo.reload", expect.any(Object)))
    fireEvent.click(screen.getByRole("button", { name: "Open Simulator" }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("expo.open-simulator", expect.any(Object)))
    fireEvent.click(screen.getByRole("button", { name: "Stop Expo preview" }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("expo.stop", expect.any(Object)))
  })

  it("keeps frame polling single-flight and cancels it on unmount", async () => {
    let releaseFrame: ((value: ExpoFrame) => void) | undefined
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "expo.status") return Promise.resolve(running)
      if (command === "expo.frame") {
        return new Promise<ExpoFrame>((resolve) => {
          releaseFrame = resolve
        })
      }
      return Promise.resolve(undefined)
    })
    const view = render(<ExpoTab pluginId="expo" session={session} />)
    await waitFor(() =>
      expect(mocks.invoke.mock.calls.filter(([command]) => command === "expo.frame")).toHaveLength(1)
    )

    vi.useFakeTimers()
    await act(async () => {
      vi.advanceTimersByTime(5_000)
    })
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "expo.frame")).toHaveLength(1)

    view.unmount()
    await act(async () => {
      releaseFrame?.(frame)
      await Promise.resolve()
      vi.advanceTimersByTime(5_000)
    })
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "expo.frame")).toHaveLength(1)
  })
})
