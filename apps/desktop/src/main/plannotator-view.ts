import type { BrowserBounds, PlanDocument } from "@jingler/core"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  app,
  type BrowserWindow,
  ipcMain,
  protocol,
  session,
  WebContentsView
} from "electron"

export const PLANNOTATOR_SCHEME = "jingler-plan"
export const PLANNOTATOR_OPEN_CHANNEL = "jingler/plannotator/open"
export const PLANNOTATOR_HIDE_CHANNEL = "jingler/plannotator/hide"
export const PLANNOTATOR_DECISION_CHANNEL = "jingler/plannotator/decision"
const PLANNOTATOR_STATE_CHANNEL = "jingler/plannotator/state"
const PARTITION = "jingler-plannotator"
const REVIEW_URL = `${PLANNOTATOR_SCHEME}://review/`

type Owner = { readonly sessionId: string; readonly chatId: string }
type OpenPayload = Owner & {
  readonly bounds: BrowserBounds
  readonly document: PlanDocument
  readonly canDecide: boolean
}
type Decision = {
  readonly reviewId: string
  readonly approved: boolean
  readonly feedback?: string
}

const ownerKey = ({ sessionId, chatId }: Owner): string => `${sessionId}\0${chatId}`
const rectOf = ({ x, y, width, height }: BrowserBounds) => ({
  x: Math.round(x),
  y: Math.round(y),
  width: Math.max(0, Math.round(width)),
  height: Math.max(0, Math.round(height))
})

const isOwner = (value: unknown): value is Owner => {
  if (value === null || typeof value !== "object") return false
  const owner = value as Partial<Owner>
  return typeof owner.sessionId === "string" && typeof owner.chatId === "string"
}

const isBounds = (value: unknown): value is BrowserBounds => {
  if (value === null || typeof value !== "object") return false
  const bounds = value as Partial<BrowserBounds>
  return [bounds.x, bounds.y, bounds.width, bounds.height]
    .every((part) => typeof part === "number" && Number.isFinite(part))
}

export const registerPlannotatorScheme = (): void => {
  protocol.registerSchemesAsPrivileged([{
    scheme: PLANNOTATOR_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }])
}

const reviewAssetPath = (): string =>
  app.isPackaged
    ? join(process.resourcesPath, "plannotator", "review-plan.html")
    : resolve(import.meta.dirname, "../../../../packages/plannotator-ext/review-plan.html")

export const installPlannotatorView = (
  windowOf: () => BrowserWindow | null
): (() => void) => {
  const partition = session.fromPartition(PARTITION)
  void partition.protocol.handle(PLANNOTATOR_SCHEME, async (request) => {
    const url = new URL(request.url)
    if (request.method !== "GET" || url.hostname !== "review" || url.pathname !== "/") {
      return new Response("Not found", { status: 404 })
    }
    return new Response(await readFile(reviewAssetPath()), {
      headers: { "content-type": "text/html; charset=utf-8" }
    })
  })
  partition.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(REVIEW_URL) })
  })

  const views = new Map<string, {
    readonly owner: Owner
    readonly view: WebContentsView
    reviewId?: string
  }>()

  const ensureView = (owner: Owner): WebContentsView | null => {
    const key = ownerKey(owner)
    const existing = views.get(key)
    if (existing) return existing.view
    const window = windowOf()
    if (!window) return null
    const view = new WebContentsView({
      webPreferences: {
        preload: join(import.meta.dirname, "../preload/plannotator.mjs"),
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    view.setVisible(false)
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    view.webContents.on("will-navigate", (event, url) => {
      if (url !== REVIEW_URL) event.preventDefault()
    })
    window.contentView.addChildView(view)
    views.set(key, { owner, view })
    view.webContents.once("destroyed", () => views.delete(key))
    return view
  }

  ipcMain.handle(PLANNOTATOR_OPEN_CHANNEL, async (_event, value: unknown) => {
    if (value === null || typeof value !== "object") return
    const payload = value as Partial<OpenPayload>
    if (!isOwner(payload) || !isBounds(payload.bounds) || payload.document === undefined) return
    const view = ensureView(payload)
    if (!view) return
    view.setBounds(rectOf(payload.bounds))
    const entry = views.get(ownerKey(payload))
    if (!entry) return
    entry.reviewId = payload.document.reviewId
    const state = {
      document: payload.document,
      reviewId: payload.document.reviewId,
      canDecide: payload.canDecide === true
    }
    if (view.webContents.getURL() === "") {
      view.webContents.once("did-finish-load", () => view.webContents.send(PLANNOTATOR_STATE_CHANNEL, state))
      await view.webContents.loadURL(REVIEW_URL)
    } else {
      view.webContents.send(PLANNOTATOR_STATE_CHANNEL, state)
    }
    view.setVisible(true)
  })

  ipcMain.on(PLANNOTATOR_HIDE_CHANNEL, (_event, value: unknown) => {
    if (!isOwner(value)) return
    views.get(ownerKey(value))?.view.setVisible(false)
  })

  ipcMain.on(PLANNOTATOR_DECISION_CHANNEL, (event, value: unknown) => {
    const entry = [...views.values()]
      .find(({ view }) => view.webContents.id === event.sender.id)
    if (!entry || value === null || typeof value !== "object") return
    const decision = value as Partial<Decision>
    if (
      typeof decision.approved !== "boolean" ||
      typeof decision.reviewId !== "string" ||
      decision.reviewId !== entry.reviewId
    ) return
    windowOf()?.webContents.send(PLANNOTATOR_DECISION_CHANNEL, {
      ...entry.owner,
      reviewId: decision.reviewId,
      approved: decision.approved,
      ...(typeof decision.feedback === "string" ? { feedback: decision.feedback } : {})
    })
  })

  return () => {
    ipcMain.removeHandler(PLANNOTATOR_OPEN_CHANNEL)
    ipcMain.removeAllListeners(PLANNOTATOR_HIDE_CHANNEL)
    ipcMain.removeAllListeners(PLANNOTATOR_DECISION_CHANNEL)
    for (const { view } of views.values()) {
      windowOf()?.contentView.removeChildView(view)
      if (!view.webContents.isDestroyed()) view.webContents.close()
    }
    views.clear()
    void partition.protocol.unhandle(PLANNOTATOR_SCHEME)
  }
}
