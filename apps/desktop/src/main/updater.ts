import { dialog, ipcMain, type BrowserWindow } from "electron"
import electronUpdater from "electron-updater"
import type { UpdateState } from "../shared/update.js"

const { autoUpdater } = electronUpdater

export const UPDATE_STATE_CHANNEL = "jingler/update-state"
export const UPDATE_GET_STATE_CHANNEL = "jingler/update/get-state"
export const UPDATE_DOWNLOAD_CHANNEL = "jingler/update/download"
export const UPDATE_INSTALL_CHANNEL = "jingler/update/install"

const TWO_HOURS = 2 * 60 * 60 * 1000
const NIGHTLY_VERSION = /-nightly\./

/**
 * Which release feed this build follows. Nightly builds carry a
 * `-nightly.<date>.<run>` version and read the `nightly*.yml` manifests; every
 * other build stays on stable (`latest*.yml`) and never sees a prerelease.
 */
export const updateChannelFor = (version: string): "latest" | "nightly" =>
  NIGHTLY_VERSION.test(version) ? "nightly" : "latest"

export function initAutoUpdater(getWindow: () => BrowserWindow | null): void {
  let state: UpdateState | null = null

  const publish = (next: UpdateState) => {
    state = next
    const window = getWindow()
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.send(UPDATE_STATE_CHANNEL, next)
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  const channel = updateChannelFor(autoUpdater.currentVersion.version)
  autoUpdater.channel = channel
  autoUpdater.allowPrerelease = channel === "nightly"
  // A stable build must never step down to an older version, and a nightly
  // build moving to the stable channel is a user choice we do not make here.
  autoUpdater.allowDowngrade = false

  const confirmInstall = async () => {
    if (state?.status !== "downloaded") return
    const { response } = await dialog.showMessageBox({
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Update ready",
      message: `Jingler ${state.version} is ready to install.`,
      detail: "Restart Jingler now to finish the update?"
    })
    if (response === 0) autoUpdater.quitAndInstall()
  }

  autoUpdater.on("update-available", (info) => {
    if (state?.status === "downloading" || state?.status === "downloaded") return
    publish({ status: "available", version: info.version })
  })

  autoUpdater.on("download-progress", (progress) => {
    if (state?.status !== "downloading") return
    publish({ status: "downloading", version: state.version, percent: progress.percent })
  })

  autoUpdater.on("update-downloaded", (info) => {
    publish({ status: "downloaded", version: info.version })
    void confirmInstall()
  })

  autoUpdater.on("error", (error) => {
    console.error("[updater]", error)
    if (state?.status === "downloading") {
      publish({ status: "available", version: state.version, error: "Download failed. Try again." })
    }
  })

  ipcMain.handle(UPDATE_GET_STATE_CHANNEL, () => state)
  ipcMain.handle(UPDATE_DOWNLOAD_CHANNEL, async () => {
    if (state?.status !== "available") return
    publish({ status: "downloading", version: state.version, percent: 0 })
    try {
      await autoUpdater.downloadUpdate()
    } catch (error) {
      console.error("[updater] download failed", error)
      publish({ status: "available", version: state.version, error: "Download failed. Try again." })
    }
  })
  ipcMain.handle(UPDATE_INSTALL_CHANNEL, confirmInstall)

  const check = () => {
    if (state?.status === "downloading" || state?.status === "downloaded") return
    return autoUpdater.checkForUpdates().catch((error) => console.error("[updater] check failed", error))
  }

  void check()
  setInterval(() => void check(), TWO_HOURS)
}
