import { app, ipcMain } from "electron"

export const APP_VERSION_CHANNEL = "jingler/app-version"

export function registerAppVersionChannel(): void {
  ipcMain.on(APP_VERSION_CHANNEL, (event) => {
    event.returnValue = app.getVersion()
  })
}
