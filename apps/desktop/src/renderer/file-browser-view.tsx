import { useEffect, useRef, useState, type ReactNode } from "react"
import type { AssetPayload, Session } from "@jingler/core"
import {
  AssetBrowser,
  AssetCanvas,
  AssetError,
  AssetTooLarge,
  AssetUnsupported,
  Button,
  Callout,
  createPierreCodeViewItem,
  createPierreFileContents,
  InlineStatus,
  FileQuickOpen,
  PierreEditor
} from "@jingler/ui"
import type { PierreAnnotationMetadata } from "@jingler/ui"
import { Eye, FilePenLine, FileWarning, RefreshCw, RotateCcw, Save } from "lucide-react"
import type { FileBrowserController, FileBrowserStatus } from "./use-file-browser.js"
import { useFileBrowser } from "./use-file-browser.js"
import { useNativeViewBounds } from "./use-native-view-bounds.js"
import { rpc } from "./rpc-client.js"

export interface FileBrowserViewProps {
  readonly session: Session
}

export interface FileBrowserQuickOpenProps {
  readonly session: Session
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onOpenPath: (path: string) => void
}

export function FileBrowserQuickOpen({
  session,
  open,
  onOpenChange,
  onOpenPath
}: FileBrowserQuickOpenProps) {
  const browser = useFileBrowser(session.id)
  return (
    <FileQuickOpen
      open={open}
      onOpenChange={onOpenChange}
      entries={browser.entries}
      sessionTitle={session.title}
      loading={browser.treeLoading}
      error={browser.treeError}
      onOpenPath={(path) => {
        browser.open(path)
        onOpenPath(path)
      }}
    />
  )
}

/** Renderer-owned binding from a session's persistent actor to the Files tab. */
export function FileBrowserView({ session }: FileBrowserViewProps) {
  const browser = useFileBrowser(session.id)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const root = rootRef.current
      if (root === null || !(event.target instanceof Node) || !root.contains(event.target)) return
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      if (event.code !== "KeyS" && event.key.toLowerCase() !== "s") return
      if (browser.status !== "dirty" && browser.status !== "error") return
      event.preventDefault()
      browser.save()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [browser.save, browser.status])

  return (
    <div ref={rootRef} className="h-full min-h-0">
      <AssetBrowser
        sessionId={session.id}
        entries={browser.entries}
        selectedPath={browser.selectedPath}
        treeLoading={browser.treeLoading}
        treeError={browser.treeError}
        onRetryTree={browser.refreshTree}
        onSelectPath={browser.open}
        headerActions={<FileActions browser={browser} />}
        renderCanvas={(nativeAvailable) => (
          <FileCanvas
            sessionId={session.id}
            browser={browser}
            nativeAvailable={nativeAvailable}
          />
        )}
      />
    </div>
  )
}

function FileActions({ browser }: { readonly browser: FileBrowserController }) {
  const textPayload = browser.payload !== null && "text" in browser.payload
  const richPreview =
    browser.payload?.kind === "markdown" || browser.payload?.kind === "csv"
  const selected = browser.selectedPath !== null
  return (
    <>
      <FileStatus status={browser.status} dirty={browser.dirty} />
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={browser.refreshTree}
        disabled={browser.treeLoading}
        title="Refresh repository files"
      >
        <RefreshCw className="size-3" aria-hidden />
        Refresh
      </Button>
      {richPreview ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={browser.viewMode === "preview" ? browser.startEdit : browser.showPreview}
          disabled={browser.status === "loading" || browser.status === "saving"}
        >
          {browser.viewMode === "preview" ? (
            <FilePenLine className="size-3" aria-hidden />
          ) : (
            <Eye className="size-3" aria-hidden />
          )}
          {browser.viewMode === "preview" ? "Edit" : "Preview"}
        </Button>
      ) : null}
      {selected ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={browser.reload}
          disabled={browser.status === "loading" || browser.status === "saving"}
          title={browser.dirty ? "Discard this draft and reload from disk" : "Reload from disk"}
        >
          <RotateCcw className="size-3" aria-hidden />
          Reload
        </Button>
      ) : null}
      {textPayload ? (
        <Button
          type="button"
          size="sm"
          onClick={browser.save}
          disabled={browser.status !== "dirty" && browser.status !== "error"}
          title="Save file (⌘S)"
        >
          <Save className="size-3" aria-hidden />
          {browser.status === "saving"
            ? "Saving…"
            : browser.status === "error"
              ? "Retry save"
              : "Save"}
        </Button>
      ) : null}
    </>
  )
}

function FileStatus({ status, dirty }: { readonly status: FileBrowserStatus; readonly dirty: boolean }) {
  if (status === "saving") return <InlineStatus variant="loading">Saving…</InlineStatus>
  if (status === "saved") return <InlineStatus variant="success">Saved</InlineStatus>
  if (status === "conflict") return <InlineStatus variant="error">Conflict</InlineStatus>
  if (dirty) return <span className="text-[11px] text-yellow">Unsaved</span>
  if (status === "read-only") return <span className="text-[11px] text-dim">Preview only</span>
  return null
}

function FileCanvas({
  sessionId,
  browser,
  nativeAvailable
}: {
  readonly sessionId: string
  readonly browser: FileBrowserController
  readonly nativeAvailable: boolean
}) {
  const payload = browser.payload
  if (browser.selectedPath === null) {
    return <AssetCanvas selectedPath={null} />
  }
  if (browser.status === "loading") {
    return <AssetCanvas selectedPath={browser.selectedPath} loading />
  }
  if (browser.status === "binary") {
    return (
      <FileNotice
        icon={<FileWarning className="size-6 text-dim" aria-hidden />}
        title="Binary file"
        detail="This file is not valid UTF-8 text, so Jingler will not edit it."
        onReveal={() => void rpc.assetReveal(sessionId, browser.selectedPath ?? "")}
      />
    )
  }
  if (browser.status === "too-large" && browser.failure?.type === "too-large") {
    return (
      <AssetTooLarge
        path={browser.failure.path}
        size={browser.failure.size}
        cap={browser.failure.cap}
        onReveal={() => void rpc.assetReveal(sessionId, browser.selectedPath ?? "")}
      />
    )
  }
  if (browser.failure?.type === "unsupported") {
    return (
      <AssetUnsupported
        path={browser.failure.path}
        onReveal={() => void rpc.assetReveal(sessionId, browser.selectedPath ?? "")}
      />
    )
  }
  if (browser.status === "error" && payload === null) {
    return (
      <AssetError
        message={
          browser.failure?.type === "error"
            ? browser.failure.message
            : `Couldn't open ${browser.selectedPath}.`
        }
      />
    )
  }
  if (payload !== null && !("text" in payload)) {
    return (
      <AssetCanvas
        selectedPath={browser.selectedPath}
        payload={payload}
        onReveal={() => void rpc.assetReveal(sessionId, payload.path)}
        renderPdf={(placeholder) => (
          <FilePdfBody
            sessionId={sessionId}
            path={payload.path}
            active={nativeAvailable}
          >
            {placeholder}
          </FilePdfBody>
        )}
      />
    )
  }
  if (payload === null || !("text" in payload) || browser.draft === null) {
    return <AssetCanvas selectedPath={browser.selectedPath} loading />
  }

  const conflictRevision =
    browser.failure?.type === "conflict" ? browser.failure.actualRevision : ""

  const richPreview = payload.kind === "markdown" || payload.kind === "csv"
  const body = richPreview && browser.viewMode === "preview" ? (
    <AssetCanvas
      selectedPath={payload.path}
      payload={{ ...payload, text: browser.draft }}
      onReveal={() => void rpc.assetReveal(sessionId, payload.path)}
    />
  ) : (
    <TextFileEditor
      key={`${payload.path}:${payload.revision}:${conflictRevision}`}
      payload={payload}
      initialDraft={browser.draft}
      browser={browser}
    />
  )

  return browser.pendingDiscard === null ? body : (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <Callout tone="yellow" className="m-2 flex-none">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1">
            Discard your unsaved changes and {browser.pendingDiscard.type === "open"
              ? `open ${browser.pendingDiscard.path}`
              : "reload this file"}?
          </span>
          <Button type="button" variant="secondary" size="sm" onClick={browser.cancelDiscard}>
            Keep editing
          </Button>
          <Button type="button" size="sm" onClick={browser.confirmDiscard}>
            Discard
          </Button>
        </div>
      </Callout>
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  )
}

/**
 * One Pierre item per loaded disk revision. During that mount Pierre owns its
 * editing document and the actor mirrors callbacks; rebuilding the controlled
 * item on every key lets the beta reconciler repaint the loaded text. A tab
 * remount seeds a fresh item from the actor's retained draft, while save/reload
 * changes the revision key and deliberately starts a new editing document. A
 * stale write also remounts against the conflicting disk revision so Pierre
 * cannot repaint the last saved item when the conflict notice changes layout.
 */
function TextFileEditor({
  payload,
  initialDraft,
  browser
}: {
  readonly payload: Extract<AssetPayload, { readonly text: string }>
  readonly initialDraft: string
  readonly browser: FileBrowserController
}) {
  const [items] = useState(() => {
    const file = createPierreFileContents({
      path: payload.path,
      contents: initialDraft,
      language: payload.language ?? "text",
      revision: payload.revision
    })
    return [
      createPierreCodeViewItem<PierreAnnotationMetadata>({
        type: "file",
        file,
        id: payload.path
      })
    ]
  })
  const item = items[0]!

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      {browser.status === "conflict" ? (
        <Callout tone="red" className="m-2 flex-none">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1">
              The file changed on disk before this save. Your draft is still here. Refresh the
              revision to keep editing and save against the agent's latest version.
            </span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={browser.refreshConflict}
            >
              Refresh revision
            </Button>
          </div>
        </Callout>
      ) : null}
      {browser.status === "error" && browser.failure?.type === "error" ? (
        <Callout tone="red" className="m-2 flex-none">
          {browser.failure.message} Your draft has not been discarded.
        </Callout>
      ) : null}
      <PierreEditor
        label={`${payload.path} editor`}
        className="min-h-0 flex-1 bg-canvas"
        items={items}
        editingItemId={item.id}
        onChange={({ contents }) => browser.edit(contents)}
        onComplete={({ contents }) => browser.edit(contents)}
        options={{ lineNumbers: true, stickyHeader: false }}
      />
    </div>
  )
}

function FileNotice({
  icon,
  title,
  detail,
  onReveal
}: {
  readonly icon: ReactNode
  readonly title: string
  readonly detail: string
  readonly onReveal?: () => void
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-canvas px-6 text-center">
      {icon}
      <div className="space-y-1">
        <p className="text-[13px] font-medium text-text-bright">{title}</p>
        <p className="text-[12px] text-dim">{detail}</p>
      </div>
      {onReveal !== undefined ? (
        <Button type="button" variant="secondary" size="sm" onClick={onReveal}>
          Reveal in Finder
        </Button>
      ) : null}
    </div>
  )
}

function FilePdfBody({
  sessionId,
  path,
  active,
  children
}: {
  readonly sessionId: string
  readonly path: string
  readonly active: boolean
  readonly children: ReactNode
}) {
  const boundsRef = useNativeViewBounds({
    active,
    onFirstPaintableRect: (rect) => {
      void rpc.assetOpenPdf(sessionId, path, rect).catch(() => {})
    },
    onBoundsChanged: (rect) => {
      void rpc.assetSetPdfBounds(sessionId, rect).catch(() => {})
    }
  })

  useEffect(() => {
    if (!active) void rpc.assetHidePdf(sessionId).catch(() => {})
    return () => {
      void rpc.assetHidePdf(sessionId).catch(() => {})
    }
  }, [active, sessionId])

  return (
    <div className="absolute inset-0">
      <div ref={boundsRef} className="absolute inset-0" />
      {children}
    </div>
  )
}
