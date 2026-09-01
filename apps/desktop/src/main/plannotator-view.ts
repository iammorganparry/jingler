import {
  BrowserBounds,
  type BrowserBounds as BrowserBoundsData,
  PlanDocument,
  type PlanDocument as PlanDocumentData
} from "@jingler/core"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { Option, Schema } from "effect"
import {
  app,
  type BrowserWindow,
  ipcMain,
  protocol,
  session,
  type Session,
  WebContentsView
} from "electron"

export const PLANNOTATOR_SCHEME = "jingler-plan"
export const PLANNOTATOR_OPEN_CHANNEL = "jingler/plannotator/open"
export const PLANNOTATOR_HIDE_CHANNEL = "jingler/plannotator/hide"
export const PLANNOTATOR_CLOSE_CHANNEL = "jingler/plannotator/close"
export const PLANNOTATOR_CLOSE_SESSION_CHANNEL = "jingler/plannotator/close-session"
export const PLANNOTATOR_DECISION_CHANNEL = "jingler/plannotator/decision"
const PARTITION = "jingler-plannotator"

const Owner = Schema.Struct({ sessionId: Schema.String, chatId: Schema.String })
type Owner = Schema.Schema.Type<typeof Owner>
const OpenPayload = Schema.Struct({
  ...Owner.fields,
  bounds: BrowserBounds,
  document: PlanDocument,
  canDecide: Schema.Boolean
})
type OpenPayload = Schema.Schema.Type<typeof OpenPayload>
type ViewEntry = {
  readonly owner: Owner
  readonly token: string
  readonly url: string
  readonly view: WebContentsView
  document: PlanDocumentData
  canDecide: boolean
  signature: string
  loading?: Promise<void>
}
type Host = {
  readonly windowOf: () => BrowserWindow | null
  readonly partition: Session
  readonly views: Map<string, ViewEntry>
  readonly viewsByToken: Map<string, ViewEntry>
  readonly settledReviewIds: Set<string>
  reviewHtml?: Promise<string>
}

const ownerKey = ({ sessionId, chatId }: Owner): string => `${sessionId}\0${chatId}`
const rectOf = ({ x, y, width, height }: BrowserBoundsData) => ({
  x: Math.round(x),
  y: Math.round(y),
  width: Math.max(0, Math.round(width)),
  height: Math.max(0, Math.round(height))
})
const stateSignature = ({ document, canDecide }: Pick<OpenPayload, "document" | "canDecide">) =>
  `${document.reviewId ?? ""}\0${document.status}\0${document.sourceMarkdown ?? ""}\0${canDecide}`

const decodeOwner = Schema.decodeUnknownOption(Owner)
const decodeOpenPayload = Schema.decodeUnknownOption(OpenPayload)
const json = <A>(body: A, status = 200): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } })

const feedbackOf = async (request: Request): Promise<string | undefined> => {
  const body = Schema.decodeUnknownOption(Schema.Struct({
    feedback: Schema.optional(Schema.String)
  }))(await request.json().catch(() => null))
  return Option.isSome(body) ? body.value.feedback?.trim() || undefined : undefined
}

export const registerPlannotatorScheme = (): void => {
  protocol.registerSchemesAsPrivileged([{
    scheme: PLANNOTATOR_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  }])
}

const reviewAssetPath = (): string =>
  app.isPackaged
    ? join(process.resourcesPath, "plannotator", "plan-review-v0.27.8.html")
    : resolve(
        import.meta.dirname,
        "../../../../packages/plannotator-ext/assets/plan-review-v0.27.8.html"
      )

const destroyEntry = (host: Host, entry: ViewEntry): void => {
  host.views.delete(ownerKey(entry.owner))
  host.viewsByToken.delete(entry.token)
  host.windowOf()?.contentView.removeChildView(entry.view)
  if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close()
}

const sendDecision = async (
  host: Host,
  entry: ViewEntry,
  approved: boolean,
  request: Request
): Promise<Response> => {
  const reviewId = entry.document.reviewId
  const feedback = await feedbackOf(request)
  const current = host.viewsByToken.get(entry.token)
  const window = host.windowOf()
  if (
    current !== entry ||
    !entry.canDecide ||
    entry.document.reviewId !== reviewId ||
    reviewId === undefined ||
    host.settledReviewIds.has(reviewId) ||
    window === null ||
    window.webContents.isDestroyed()
  ) return json({ error: "Review is no longer pending." }, 409)

  host.settledReviewIds.add(reviewId)
  entry.canDecide = false
  try {
    window.webContents.send(PLANNOTATOR_DECISION_CHANNEL, {
      ...entry.owner,
      reviewId,
      approved,
      feedback
    })
    return json({ ok: true })
  } catch {
    host.settledReviewIds.delete(reviewId)
    entry.canDecide = true
    return json({ error: "Could not deliver the review decision." }, 503)
  }
}

const handleGet = async (host: Host, entry: ViewEntry, path: string): Promise<Response> => {
  if (path === "/") {
    host.reviewHtml ??= readFile(reviewAssetPath(), "utf8")
    return new Response(await host.reviewHtml, {
      headers: { "content-type": "text/html; charset=utf-8" }
    })
  }
  if (path === "/api/plan") {
    const readOnly = !entry.canDecide || entry.document.reviewId === undefined
    return json({
      plan: entry.document.sourceMarkdown ?? entry.document.plan.title,
      origin: "pi",
      mode: readOnly ? "archive" : undefined,
      archivePlans: readOnly ? [] : undefined,
      sharingEnabled: false,
      approvalNotesSupported: true,
      serverConfig: { displayName: "Jingler" }
    })
  }
  if (path === "/api/ai/capabilities") return json({ available: false, providers: [] })
  if (path === "/api/skills") return json({ skills: [] })
  if (path === "/api/archive/plans") return json({ plans: [] })
  if (path === "/api/external-annotations") return json({ annotations: [], version: 0 })
  if (path === "/api/draft") return json(null)
  if (path === "/api/hooks/status") {
    return json({
      pfmReminder: { enabled: false },
      improvementHook: { present: false, filePath: null, fileSize: null, content: null },
      composedLength: null
    })
  }
  if (path === "/api/external-annotations/stream") {
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(": connected\n\n"))
      }
    }), { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } })
  }
  return json({ error: "Not found" }, 404)
}

const handlePost = (
  host: Host,
  entry: ViewEntry,
  path: string,
  request: Request
): Promise<Response> | Response => {
  if (path === "/api/approve") return sendDecision(host, entry, true, request)
  if (path === "/api/deny" || path === "/api/feedback") {
    return sendDecision(host, entry, false, request)
  }
  if (
    path === "/api/config" ||
    path === "/api/draft" ||
    path === "/api/external-annotations"
  ) return json({ ok: true })
  return json({ error: "Not found" }, 404)
}

const handleProtocol = async (host: Host, request: Request): Promise<Response> => {
  const url = new URL(request.url)
  const entry = host.viewsByToken.get(url.hostname)
  if (!entry) return new Response("Not found", { status: 404 })
  if (request.method === "GET") return handleGet(host, entry, url.pathname)
  if (request.method === "POST") return handlePost(host, entry, url.pathname, request)
  if (
    url.pathname === "/api/draft" ||
    url.pathname === "/api/external-annotations"
  ) return json({ ok: true })
  return json({ error: "Not found" }, 404)
}

const createEntry = (host: Host, payload: OpenPayload): ViewEntry | null => {
  const window = host.windowOf()
  if (!window) return null
  const token = randomUUID()
  const url = `${PLANNOTATOR_SCHEME}://${token}/`
  const view = new WebContentsView({
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  const entry: ViewEntry = {
    owner: { sessionId: payload.sessionId, chatId: payload.chatId },
    token,
    url,
    view,
    document: payload.document,
    canDecide: payload.canDecide,
    signature: stateSignature(payload)
  }
  view.setVisible(false)
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  view.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin !== new URL(url).origin) event.preventDefault()
  })
  view.webContents.once("destroyed", () => {
    host.views.delete(ownerKey(entry.owner))
    host.viewsByToken.delete(token)
  })
  window.contentView.addChildView(view)
  host.views.set(ownerKey(entry.owner), entry)
  host.viewsByToken.set(token, entry)
  return entry
}

const openEntry = async (host: Host, payload: OpenPayload): Promise<void> => {
  const entry = host.views.get(ownerKey(payload)) ?? createEntry(host, payload)
  if (!entry) return
  entry.view.setBounds(rectOf(payload.bounds))
  const signature = stateSignature(payload)
  const changed = signature !== entry.signature
  entry.document = payload.document
  entry.canDecide = payload.canDecide &&
    payload.document.reviewId !== undefined &&
    !host.settledReviewIds.has(payload.document.reviewId)
  entry.signature = signature

  if (entry.view.webContents.getURL() === "") {
    entry.loading ??= entry.view.webContents.loadURL(entry.url).finally(() => {
      entry.loading = undefined
    })
    await entry.loading
  } else if (changed && entry.loading === undefined) {
    entry.view.webContents.reload()
  }
  entry.view.setVisible(true)
}

export const installPlannotatorView = (
  windowOf: () => BrowserWindow | null
): (() => void) => {
  const host: Host = {
    windowOf,
    partition: session.fromPartition(PARTITION),
    views: new Map(),
    viewsByToken: new Map(),
    settledReviewIds: new Set()
  }
  host.partition.protocol.handle(PLANNOTATOR_SCHEME, (request) => handleProtocol(host, request))
  host.partition.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url)
    callback({
      cancel: url.protocol !== `${PLANNOTATOR_SCHEME}:` || !host.viewsByToken.has(url.hostname)
    })
  })

  const hide = (_event: Electron.IpcMainEvent, value: Owner) => {
    const owner = decodeOwner(value)
    if (Option.isSome(owner)) host.views.get(ownerKey(owner.value))?.view.setVisible(false)
  }
  const close = (_event: Electron.IpcMainEvent, value: Owner) => {
    const owner = decodeOwner(value)
    if (Option.isNone(owner)) return
    const entry = host.views.get(ownerKey(owner.value))
    if (entry) destroyEntry(host, entry)
  }
  const closeSession = (_event: Electron.IpcMainEvent, sessionId: string) => {
    for (const entry of [...host.views.values()]) {
      if (entry.owner.sessionId === sessionId) destroyEntry(host, entry)
    }
  }
  ipcMain.handle(PLANNOTATOR_OPEN_CHANNEL, (_event, value: OpenPayload) => {
    const payload = decodeOpenPayload(value)
    return Option.isSome(payload) ? openEntry(host, payload.value) : undefined
  })
  ipcMain.on(PLANNOTATOR_HIDE_CHANNEL, hide)
  ipcMain.on(PLANNOTATOR_CLOSE_CHANNEL, close)
  ipcMain.on(PLANNOTATOR_CLOSE_SESSION_CHANNEL, closeSession)

  return () => {
    ipcMain.removeHandler(PLANNOTATOR_OPEN_CHANNEL)
    ipcMain.removeListener(PLANNOTATOR_HIDE_CHANNEL, hide)
    ipcMain.removeListener(PLANNOTATOR_CLOSE_CHANNEL, close)
    ipcMain.removeListener(PLANNOTATOR_CLOSE_SESSION_CHANNEL, closeSession)
    for (const entry of [...host.views.values()]) destroyEntry(host, entry)
    host.partition.protocol.unhandle(PLANNOTATOR_SCHEME)
  }
}
