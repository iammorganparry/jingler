import { contextBridge, ipcRenderer } from "electron"

const STATE_CHANNEL = "jingler/plannotator/state"
const DECISION_CHANNEL = "jingler/plannotator/decision"

let reviewId: string | undefined

contextBridge.exposeInMainWorld("plannotator", {
  onState: (callback: (state: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      const candidate = (state as { readonly reviewId?: unknown } | null)?.reviewId
      reviewId = typeof candidate === "string" ? candidate : undefined
      callback(state)
    }
    ipcRenderer.on(STATE_CHANNEL, listener)
    return () => ipcRenderer.removeListener(STATE_CHANNEL, listener)
  },
  decide: (approved: boolean, feedback?: string) => {
    ipcRenderer.send(DECISION_CHANNEL, {
      approved,
      ...(reviewId === undefined ? {} : { reviewId }),
      ...(typeof feedback === "string" && feedback.trim().length > 0
        ? { feedback: feedback.trim() }
        : {})
    })
  }
})
