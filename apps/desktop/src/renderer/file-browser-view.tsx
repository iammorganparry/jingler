import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
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
  DiffView,
  FileQuickOpen,
  parsePierreFileDiffs,
  PierreEditor
} from "@jingler/ui"
import type { PierreAnnotationMetadata } from "@jingler/ui"
import type { JinglerLineSelection } from "@jingler/ui"
import { FileWarning } from "lucide-react"
import type { FileBrowserController } from "./use-file-browser.js"
import { useFileBrowser } from "./use-file-browser.js"
import { useNativeViewBounds } from "./use-native-view-bounds.js"
import { rpc } from "./rpc-client.js"
import { captureCodeReference, type CodeReference } from "./code-reference.js"

export interface FileBrowserViewProps {
  readonly session: Session
  readonly onSendReference?: (reference: CodeReference) => void
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
export function FileBrowserView({ session, onSendReference }: FileBrowserViewProps) {
  const browser = useFileBrowser(session.id)
  const rootRef = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<JinglerLineSelection | null>(null)
  const activated = useRef(false)

  useEffect(() => setSelection(null), [browser.selectedPath, browser.payload])

  // The actor survives tab switches. Refresh on every Files activation so an
  // empty/error result captured before a worktree finished appearing cannot
  // leave a real repository looking permanently blank.
  useEffect(() => {
    if (activated.current) return
    activated.current = true
    // `useFileBrowser` starts a fresh actor in `tree.loading`. Re-entering that
    // state here cancelled the first full-repository scan and immediately ran
    // the same expensive request twice. Existing actors are refreshed when the
    // Files tab is reopened; new actors are allowed to finish their first load.
    if (!browser.treeLoading) browser.refreshTree()
  }, [browser.refreshTree, browser.treeLoading])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const root = rootRef.current
      if (root === null || !(event.target instanceof Node) || !root.contains(event.target)) return
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      if (
        event.shiftKey &&
        (event.code === "KeyJ" || event.key.toLowerCase() === "j") &&
        selection !== null &&
        selection.side === "new" &&
        selection.endSide === "new" &&
        browser.selectedPath !== null &&
        browser.draft !== null
      ) {
        const reference = captureCodeReference(
          browser.selectedPath,
          browser.draft,
          selection.startLine,
          selection.endLine
        )
        if (reference === null) return
        event.preventDefault()
        onSendReference?.(reference)
        return
      }
      if (event.shiftKey) return
      if (event.code !== "KeyS" && event.key.toLowerCase() !== "s") return
      if (browser.status !== "dirty" && browser.status !== "error") return
      event.preventDefault()
      browser.save()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [browser.draft, browser.save, browser.selectedPath, browser.status, onSendReference, selection])

  return (
    <div ref={rootRef} className="h-full min-h-0 min-w-0 w-full">
      <AssetBrowser
        sessionId={session.id}
        entries={browser.entries}
        selectedPath={browser.selectedPath}
        treeLoading={browser.treeLoading}
        treeError={browser.treeError}
        onRetryTree={browser.refreshTree}
        onSelectPath={browser.open}
        renderCanvas={(nativeAvailable) => (
          <FileCanvas
            sessionId={session.id}
            browser={browser}
            nativeAvailable={nativeAvailable}
            selection={selection}
            onSelectionChange={setSelection}
          />
        )}
      />
    </div>
  )
}

function FileCanvas({
  sessionId,
  browser,
  nativeAvailable,
  selection,
  onSelectionChange
}: {
  readonly sessionId: string
  readonly browser: FileBrowserController
  readonly nativeAvailable: boolean
  readonly selection: JinglerLineSelection | null
  readonly onSelectionChange: (selection: JinglerLineSelection | null) => void
}) {
  const payload = browser.payload
  const fileDiff = useMemo(() => {
    if (browser.patch === null || browser.selectedPath === null) return null
    try {
      return (
        parsePierreFileDiffs(browser.patch).find(
          (candidate) => candidate.name === browser.selectedPath
        ) ?? null
      )
    } catch {
      return null
    }
  }, [browser.patch, browser.selectedPath])
  if (browser.selectedPath === null) {
    return <AssetCanvas selectedPath={null} />
  }
  if (browser.viewMode === "diff") {
    if (fileDiff !== null) {
      return (
        <div className="flex h-full min-h-0 flex-col bg-canvas">
          <FileModeBar path={browser.selectedPath} mode="diff" browser={browser} />
          <div className="min-h-0 flex-1">
            <DiffView
              fileDiff={fileDiff}
              label={`${browser.selectedPath} changes`}
              className="h-full min-h-0"
              selection={selection}
              onSelectionChange={onSelectionChange}
              options={{
                diffStyle: "unified",
                stickyHeader: false,
                disableFileHeader: true
              }}
            />
          </div>
        </div>
      )
    }
    if (browser.patch === null && browser.patchError === null) {
      return <AssetCanvas selectedPath={browser.selectedPath} loading />
    }
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
          <FilePdfBody sessionId={sessionId} path={payload.path} active={nativeAvailable}>
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

  const editor = (
    <TextFileEditor
      key={`${payload.path}:${payload.revision}:${conflictRevision}`}
      payload={payload}
      initialDraft={browser.draft}
      browser={browser}
      selection={selection}
      onSelectionChange={onSelectionChange}
    />
  )
  const body =
    fileDiff === null ? (
      editor
    ) : (
      <div className="flex h-full min-h-0 flex-col bg-canvas">
        <FileModeBar path={browser.selectedPath} mode="edit" browser={browser} />
        <div className="min-h-0 flex-1">{editor}</div>
      </div>
    )

  return browser.pendingDiscard === null ? (
    body
  ) : (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <Callout tone="yellow" className="m-2 flex-none">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1">
            Discard your unsaved changes and{" "}
            {browser.pendingDiscard.type === "open"
              ? `open ${browser.pendingDiscard.path}`
              : browser.pendingDiscard.type === "close"
                ? `close ${browser.pendingDiscard.path}`
                : "reload this file"}
            ?
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

function FileModeBar({
  path,
  mode,
  browser
}: {
  readonly path: string
  readonly mode: "diff" | "edit"
  readonly browser: FileBrowserController
}) {
  return (
    <div className="flex h-8 flex-none items-center justify-end gap-1 border-b border-hairline bg-panel px-2">
      <Button
        type="button"
        variant={mode === "diff" ? "secondary" : "ghost"}
        size="sm"
        aria-pressed={mode === "diff"}
        aria-label={`Show diff for ${path}`}
        onClick={browser.showDiff}
      >
        Diff
      </Button>
      <Button
        type="button"
        variant={mode === "edit" ? "secondary" : "ghost"}
        size="sm"
        aria-pressed={mode === "edit"}
        aria-label={`Edit ${path}`}
        onClick={browser.startEdit}
      >
        Edit
      </Button>
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
  browser,
  selection,
  onSelectionChange
}: {
  readonly payload: Extract<AssetPayload, { readonly text: string }>
  readonly initialDraft: string
  readonly browser: FileBrowserController
  readonly selection: JinglerLineSelection | null
  readonly onSelectionChange: (selection: JinglerLineSelection | null) => void
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
            <Button type="button" variant="secondary" size="sm" onClick={browser.refreshConflict}>
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
        selection={selection}
        onSelectionChange={onSelectionChange}
        onChange={({ contents }) => browser.edit(contents)}
        onComplete={({ contents }) => browser.edit(contents)}
        options={{
          lineNumbers: true,
          stickyHeader: false,
          disableFileHeader: true
        }}
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
