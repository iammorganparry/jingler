import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    listeners,
    handlers,
    autoUpdater: {
      autoDownload: true,
      autoInstallOnAppQuit: false,
      currentVersion: { version: "0.3.1" },
      channel: null as string | null,
      allowPrerelease: true,
      allowDowngrade: true,
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener)
      }),
      checkForUpdates: vi.fn().mockResolvedValue(undefined),
      downloadUpdate: vi.fn().mockResolvedValue([]),
      quitAndInstall: vi.fn()
    },
    showMessageBox: vi.fn().mockResolvedValue({ response: 0 }),
    ipcHandle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
  }
})

vi.mock("electron", () => ({
  dialog: { showMessageBox: mocks.showMessageBox },
  ipcMain: { handle: mocks.ipcHandle }
}))

vi.mock("electron-updater", () => ({
  default: { autoUpdater: mocks.autoUpdater }
}))

import {
  initAutoUpdater,
  updateChannelFor,
  UPDATE_DOWNLOAD_CHANNEL,
  UPDATE_GET_STATE_CHANNEL,
  UPDATE_INSTALL_CHANNEL,
  UPDATE_STATE_CHANNEL
} from "./updater.js"

describe("update channels", () => {
  it("keeps stable builds on the stable feed and nightlies on the nightly feed", () => {
    expect(updateChannelFor("0.3.1")).toBe("latest")
    expect(updateChannelFor("0.4.0-nightly.20260928.12")).toBe("nightly")
  })

  it("never lets a stable build pick up a prerelease or downgrade", () => {
    mocks.autoUpdater.currentVersion = { version: "0.3.1" }
    initAutoUpdater(() => null)
    expect(mocks.autoUpdater.channel).toBe("latest")
    expect(mocks.autoUpdater.allowPrerelease).toBe(false)
    expect(mocks.autoUpdater.allowDowngrade).toBe(false)
  })

  it("points a nightly build at the nightly feed", () => {
    mocks.autoUpdater.currentVersion = { version: "0.4.0-nightly.20260928.12" }
    initAutoUpdater(() => null)
    expect(mocks.autoUpdater.channel).toBe("nightly")
    expect(mocks.autoUpdater.allowPrerelease).toBe(true)
    mocks.autoUpdater.currentVersion = { version: "0.3.1" }
  })
})

describe("initAutoUpdater", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.listeners.clear()
    mocks.handlers.clear()
    vi.clearAllMocks()
  })

  it("publishes update progress and only restarts after confirmation", async () => {
    const send = vi.fn()
    initAutoUpdater(() => ({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send }
    }) as never)

    expect(mocks.autoUpdater.autoDownload).toBe(false)
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true)
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledOnce()

    mocks.listeners.get("update-available")?.({ version: "1.2.3" })
    expect(send).toHaveBeenLastCalledWith(UPDATE_STATE_CHANNEL, {
      status: "available",
      version: "1.2.3"
    })
    expect(await mocks.handlers.get(UPDATE_GET_STATE_CHANNEL)?.()).toEqual({
      status: "available",
      version: "1.2.3"
    })

    await mocks.handlers.get(UPDATE_DOWNLOAD_CHANNEL)?.()
    expect(mocks.autoUpdater.downloadUpdate).toHaveBeenCalledOnce()
    mocks.listeners.get("download-progress")?.({ percent: 42 })
    expect(send).toHaveBeenLastCalledWith(UPDATE_STATE_CHANNEL, {
      status: "downloading",
      version: "1.2.3",
      percent: 42
    })

    mocks.listeners.get("update-downloaded")?.({ version: "1.2.3" })
    await Promise.resolve()
    expect(mocks.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      buttons: ["Restart now", "Later"]
    }))
    expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledOnce()

    const published = send.mock.calls.length
    mocks.listeners.get("download-progress")?.({ percent: 80 })
    mocks.listeners.get("update-available")?.({ version: "1.2.3" })
    expect(send).toHaveBeenCalledTimes(published)
    vi.advanceTimersByTime(2 * 60 * 60 * 1000)
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledOnce()
  })

  it("does not publish into a destroyed window", () => {
    const send = vi.fn()
    initAutoUpdater(() => ({
      isDestroyed: () => true,
      webContents: { isDestroyed: () => false, send }
    }) as never)

    mocks.listeners.get("update-available")?.({ version: "1.2.3" })

    expect(send).not.toHaveBeenCalled()
  })

  it("leaves a downloaded update for the next quit when restart is deferred", async () => {
    mocks.showMessageBox.mockResolvedValueOnce({ response: 1 })
    initAutoUpdater(() => null)
    mocks.listeners.get("update-downloaded")?.({ version: "1.2.3" })
    await Promise.resolve()

    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled()
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true)

    mocks.showMessageBox.mockResolvedValueOnce({ response: 0 })
    await mocks.handlers.get(UPDATE_INSTALL_CHANNEL)?.()
    expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledOnce()
  })
})
