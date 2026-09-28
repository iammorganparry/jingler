// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { UpdateState } from "../shared/update.js"
import { useAutoUpdate } from "./use-auto-update.js"

const available: UpdateState = { status: "available", version: "1.2.3" }

describe("useAutoUpdate", () => {
  let listener: ((state: UpdateState) => void) | undefined
  const unsubscribe = vi.fn()
  const downloadUpdate = vi.fn().mockResolvedValue(undefined)
  const installUpdate = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    localStorage.clear()
    listener = undefined
    vi.clearAllMocks()
    Object.defineProperty(window, "jingler", {
      configurable: true,
      value: {
        getUpdateState: vi.fn().mockResolvedValue(available),
        onUpdateState: vi.fn((next: (state: UpdateState) => void) => {
          listener = next
          return unsubscribe
        }),
        downloadUpdate,
        installUpdate
      } satisfies Pick<JinglerBridge, "getUpdateState" | "onUpdateState" | "downloadUpdate" | "installUpdate">
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(window, "jingler")
  })

  it("hydrates, routes actions, persists dismissal, and unsubscribes", async () => {
    const { result, unmount } = renderHook(() => useAutoUpdate())
    await waitFor(() => expect(result.current?.version).toBe("1.2.3"))

    act(() => result.current?.onAction())
    expect(downloadUpdate).toHaveBeenCalledOnce()

    act(() => result.current?.onDismiss())
    expect(result.current?.dismissed).toBe(true)
    expect(localStorage.getItem("jingler.dismissed-update-version")).toBe("1.2.3")

    act(() => listener?.({ status: "downloaded", version: "1.2.3" }))
    act(() => result.current?.onAction())
    expect(installUpdate).toHaveBeenCalledOnce()

    unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
