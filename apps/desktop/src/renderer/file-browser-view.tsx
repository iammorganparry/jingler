import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type { AssetPayload, DebugViewSnapshot, Session } from "@jingler/core"
import {
  AssetBrowser,
  AssetCanvas,
  AssetError,
  AssetTooLarge,
  AssetUnsupported,
  Button,
  Callout,
  ContextMenu,
  createPierreCodeViewItem,
  createPierreFileContents,
  DiffView,
  FileQuickOpen,
  parsePierreFileDiffs,
  PierreEditor
} from "@jingler/ui"
import type { PierreAnnotationMetadata } from "@jingler/ui"
import type { JinglerLineSelection } from "@jingler/ui"
import { Bug, ChevronDown, ChevronRight, CirclePause, CirclePlay, FileWarning, MessageSquarePlus, MousePointer2, Square, StepForward } from "lucide-react"
import type { FileBrowserController } from "./use-file-browser.js"
import { useFileBrowser } from "./use-file-browser.js"
import { useNativeViewBounds } from "./use-native-view-bounds.js"
import { rpc } from "./rpc-client.js"
import { captureCodeReference, type CodeReference } from "./code-reference.js"
import {
  normalizeAgentFileTarget,
  useAgentFileActivity
} from "./agent-file-activity.js"
import { useDebugSessionModel, type DebugSessionModel } from "./debug-session.js"
import {
  agentFollowDiffSelection,
  captureDiffCodeReference
} from "./file-diff-context.js"

const DEBUG_HOVER_IDENTIFIER = /^[\p{ID_Start}_$][\p{ID_Continue}_$\u200C\u200D]*$/u

export interface FileBrowserViewProps {
  readonly session: Session
  readonly debugSnapshot?: DebugViewSnapshot
  readonly onSendReference?: (reference: CodeReference) => void
  readonly onSendComment?: (body: string, reference: CodeReference) => void
  /** Path-owned mode used by nested file splits. */
  readonly path?: string
  readonly onClosed?: () => void
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
  const browser = useFileBrowser(session.id, session.worktreePath)
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
export function FileBrowserView({
  session,
  debugSnapshot,
  onSendReference,
  onSendComment,
  path,
  onClosed
}: FileBrowserViewProps) {
  const browser = useFileBrowser(
    session.id,
    session.worktreePath,
    path === undefined ? undefined : `file:${path}`
  )
  const debug = useDebugSessionModel(session.id, debugSnapshot)
  const debugFrame = debug.snapshot.session?.status === "stopped"
    ? (debug.snapshot.session.frame ?? null)
    : null
  const debugPath = debugFrame?.source?.path
    ? normalizeAgentFileTarget(debugFrame.source.path, session.worktreePath)
    : null
  const debugStopKey = debug.snapshot.session?.status === "stopped"
    ? `${debug.snapshot.session.id}:${debug.snapshot.session.stopSequence ?? 0}`
    : null
  const agentFileActivity = useAgentFileActivity(session.id, session.activeChatId)
  const rootRef = useRef<HTMLDivElement>(null)
  const followedDebugStop = useRef<string | null>(null)
  const selectionPathRef = useRef(browser.selectedPath)
  const pathWasOpened = useRef(false)
  const [selection, setSelection] = useState<JinglerLineSelection | null>(null)

  useEffect(() => {
    if (path !== undefined && browser.selectedPath !== path && !pathWasOpened.current) {
      browser.open(path)
    }
  }, [browser.open, browser.selectedPath, path])

  useEffect(() => {
    if (path === undefined) return
    if (browser.selectedPath === path) {
      pathWasOpened.current = true
      return
    }
    if (pathWasOpened.current && browser.selectedPath === null && browser.pendingDiscard === null) {
      onClosed?.()
    }
  }, [browser.pendingDiscard, browser.selectedPath, onClosed, path])

  useEffect(() => {
    if (selectionPathRef.current === browser.selectedPath) return
    selectionPathRef.current = browser.selectedPath
    setSelection(null)
  }, [browser.selectedPath])

  // The actor survives tab switches. Refresh on every Files activation so an
  // empty/error result captured before a worktree finished appearing cannot
  // leave a real repository looking permanently blank.
  useEffect(() => browser.activate(), [browser.activate])

  const sendSelectionToChat = useCallback(() => {
    if (
      selection === null ||
      selection.side !== "new" ||
      selection.endSide !== "new" ||
      browser.selectedPath === null ||
      browser.draft === null
    ) {
      return
    }
    const reference = captureCodeReference(
      browser.selectedPath,
      browser.draft,
      selection.startLine,
      selection.endLine
    )
    if (reference !== null) onSendReference?.(reference)
  }, [browser.draft, browser.selectedPath, onSendReference, selection])

  const canSendSelection =
    onSendReference !== undefined &&
    selection !== null &&
    selection.side === "new" &&
    selection.endSide === "new" &&
    browser.selectedPath !== null &&
    browser.draft !== null

  const normalizedAgentTarget = useMemo(
    () =>
      agentFileActivity === null
        ? null
        : normalizeAgentFileTarget(agentFileActivity.path, session.worktreePath),
    [agentFileActivity, session.worktreePath]
  )

  useEffect(() => {
    if (!browser.followEnabled || agentFileActivity === null || normalizedAgentTarget === null) return
    browser.followAgentTarget(
      normalizedAgentTarget,
      agentFileActivity.eventId,
      agentFileActivity.preview,
      agentFileActivity.phase === "completed"
    )
  }, [
    agentFileActivity,
    browser.followAgentTarget,
    browser.followEnabled,
    normalizedAgentTarget
  ])

  useEffect(() => {
    if (debugPath === null || debugStopKey === null || followedDebugStop.current === debugStopKey) return
    followedDebugStop.current = debugStopKey
    if (browser.selectedPath !== debugPath) browser.open(debugPath)
  }, [browser.open, browser.selectedPath, debugPath, debugStopKey])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const root = rootRef.current
      if (root === null || !(event.target instanceof Node) || !root.contains(event.target)) return
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      if (
        !event.shiftKey &&
        (event.code === "KeyJ" || event.key.toLowerCase() === "j") &&
        canSendSelection
      ) {
        event.preventDefault()
        sendSelectionToChat()
        return
      }
      if (event.shiftKey) return
      if (event.code !== "KeyS" && event.key.toLowerCase() !== "s") return
      if (browser.status !== "dirty" && browser.status !== "error") return
      event.preventDefault()
      browser.save()
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [browser.save, browser.status, canSendSelection, sendSelectionToChat])

  return (
    <div ref={rootRef} className="h-full min-h-0 min-w-0 w-full">
      <AssetBrowser
        sessionId={session.id}
        entries={browser.entries}
        selectedPath={browser.selectedPath}
        treeLoading={browser.treeLoading}
        treeError={browser.treeError}
        toolbar={
          <>
            {/* The open file, filename-first: the directory clips, the name
                never does. It used to sit right-aligned with a tail-truncate,
                which is exactly backwards — the ellipsis ate the filename and
                kept the least useful half of the path. */}
            {browser.selectedPath !== null ? (
              <span
                className="flex min-w-0 flex-1 items-baseline font-mono text-[10.5px]"
                title={browser.selectedPath}
              >
                {browser.selectedPath.includes("/") ? (
                  <span className="truncate text-dim">
                    {browser.selectedPath.slice(0, browser.selectedPath.lastIndexOf("/") + 1)}
                  </span>
                ) : null}
                <span className="flex-none text-text">
                  {browser.selectedPath.slice(browser.selectedPath.lastIndexOf("/") + 1)}
                </span>
              </span>
            ) : (
              <span className="flex-1" />
            )}
          <div className="ml-auto flex min-w-0 flex-none items-center gap-2">
            <button
              type="button"
              className={[
                "jingler-mode-toggle inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium outline-none transition-colors active:scale-[0.96]",
                browser.followEnabled
                  ? "is-active"
                  : "text-muted-foreground hover:text-text"
              ].join(" ")}
              aria-pressed={browser.followEnabled}
              onClick={browser.followEnabled ? browser.disableFollow : browser.enableFollow}
              title="Follow files edited by the active chat's agent"
            >
              <MousePointer2
                className="jingler-mode-toggle__mark size-3"
                aria-hidden
              />
              <span className="jingler-mode-toggle__label">Follow agent</span>
            </button>
          </div>
          </>
        }
        onRetryTree={browser.refreshTree}
        onSelectPath={browser.open}
        renderCanvas={(nativeAvailable) => (
          <div className="flex h-full min-h-0 min-w-0">
            <div className="min-w-0 flex-1">
              <FileCanvas
                sessionId={session.id}
                browser={browser}
                nativeAvailable={nativeAvailable}
                selection={selection}
                onSelectionChange={setSelection}
                onSendReference={onSendReference}
                onSendComment={onSendComment}
                canSendSelection={canSendSelection}
                onSendSelection={sendSelectionToChat}
                debug={debug}
                debugLine={debugPath === browser.selectedPath ? (debugFrame?.line ?? null) : null}
                debugRevision={debug.snapshot.session?.stopSequence ?? 0}
              />
            </div>
            {debug.snapshot.session !== null ? <DebugPanel model={debug} /> : null}
          </div>
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
  onSelectionChange,
  onSendReference,
  onSendComment,
  canSendSelection,
  onSendSelection,
  debug,
  debugLine,
  debugRevision
}: {
  readonly sessionId: string
  readonly browser: FileBrowserController
  readonly nativeAvailable: boolean
  readonly selection: JinglerLineSelection | null
  readonly onSelectionChange: (selection: JinglerLineSelection | null) => void
  readonly onSendReference: ((reference: CodeReference) => void) | undefined
  readonly onSendComment:
    | ((body: string, reference: CodeReference) => void)
    | undefined
  readonly canSendSelection: boolean
  readonly onSendSelection: () => void
  readonly debug: DebugSessionModel
  readonly debugLine: number | null
  readonly debugRevision: number
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
  const followedSelection = useMemo(() => {
    if (
      !browser.followEnabled ||
      !browser.agentTargetCompleted ||
      browser.patch === null ||
      browser.agentTargetPath === null ||
      browser.selectedPath !== browser.agentTargetPath
    ) {
      return null
    }
    return agentFollowDiffSelection(
      browser.patch,
      browser.agentTargetPath,
      browser.agentTargetPreview
    )
  }, [
    browser.agentTargetCompleted,
    browser.agentTargetPath,
    browser.agentTargetPreview,
    browser.followEnabled,
    browser.patch,
    browser.selectedPath
  ])
  useEffect(() => {
    if (followedSelection !== null) onSelectionChange(null)
  }, [followedSelection, onSelectionChange])

  const referenceForDiffSelection = useCallback(
    (next: JinglerLineSelection): CodeReference | null =>
      browser.patch === null ? null : captureDiffCodeReference(browser.patch, next),
    [browser.patch]
  )
  const addDiffSelectionToChat = useCallback(
    (next: JinglerLineSelection) => {
      const reference = referenceForDiffSelection(next)
      if (reference !== null) onSendReference?.(reference)
    },
    [onSendReference, referenceForDiffSelection]
  )
  const commentOnDiffSelection = useCallback(
    (next: JinglerLineSelection, body: string) => {
      const reference = referenceForDiffSelection(next)
      if (reference !== null) onSendComment?.(body, reference)
    },
    [onSendComment, referenceForDiffSelection]
  )
  if (browser.selectedPath === null) {
    return <AssetCanvas selectedPath={null} />
  }
  if (browser.viewMode === "diff") {
    if (fileDiff !== null) {
      return (
        <div
          key={browser.agentTargetCompleted ? browser.agentTargetEventId : undefined}
          className={[
            "flex h-full min-h-0 flex-col bg-canvas",
            followedSelection === null ? "" : "animate-slide-in"
          ].join(" ")}
          data-follow-agent-change={
            followedSelection === null ? undefined : (browser.agentTargetEventId ?? undefined)
          }
        >
          <FileModeBar path={browser.selectedPath} mode="diff" browser={browser} />
          <div className="min-h-0 flex-1">
            <DiffView
              fileDiff={fileDiff}
              label={`${browser.selectedPath} changes`}
              className="h-full min-h-0"
              selection={selection}
              onSelectionChange={onSelectionChange}
              actions={
                onSendReference === undefined && onSendComment === undefined
                  ? undefined
                  : {
                      onAddToChat: addDiffSelectionToChat,
                      onComment: commentOnDiffSelection
                    }
              }
              scrollRequest={
                followedSelection === null || browser.agentTargetEventId === null
                  ? undefined
                  : {
                      path: browser.selectedPath,
                      range: followedSelection,
                      revision: [...`${browser.agentTargetEventId}:completed`].reduce(
                        (value, character) =>
                          ((value * 31 + character.charCodeAt(0)) >>> 0),
                        0
                      ),
                      behavior: "smooth"
                    }
              }
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
    <SelectionContextMenu enabled={canSendSelection} onSelect={onSendSelection}>
      <TextFileEditor
        key={`${payload.path}:${payload.revision}:${conflictRevision}`}
        payload={payload}
        initialDraft={browser.draft}
        browser={browser}
        selection={selection}
        onSelectionChange={onSelectionChange}
        debug={debug}
        debugLine={debugLine}
        debugRevision={debugRevision}
      />
    </SelectionContextMenu>
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

function SelectionContextMenu({
  enabled,
  onSelect,
  children
}: {
  readonly enabled: boolean
  readonly onSelect: () => void
  readonly children: ReactNode
}) {
  if (!enabled) return children
  return (
    <ContextMenu
      items={[
        {
          id: "add-selection-to-chat",
          label: "Add selection to chat",
          icon: MessageSquarePlus,
          onSelect
        }
      ]}
    >
      <div className="contents">{children}</div>
    </ContextMenu>
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
  onSelectionChange,
  debug,
  debugLine,
  debugRevision
}: {
  readonly payload: Extract<AssetPayload, { readonly text: string }>
  readonly initialDraft: string
  readonly browser: FileBrowserController
  readonly selection: JinglerLineSelection | null
  readonly onSelectionChange: (selection: JinglerLineSelection | null) => void
  readonly debug: DebugSessionModel
  readonly debugLine: number | null
  readonly debugRevision: number
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverGeneration = useRef(0)
  const [hover, setHover] = useState<{ x: number; y: number; expression: string; value?: string; type?: string } | null>(null)
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

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const mark = () => {
      for (const row of root.querySelectorAll<HTMLElement>("[data-debug-current-line]")) {
        row.removeAttribute("data-debug-current-line")
      }
      if (debugLine === null) return
      for (const row of root.querySelectorAll<HTMLElement>(`[data-line="${debugLine}"]`)) {
        row.setAttribute("data-debug-current-line", "true")
      }
    }
    mark()
    const observer = new MutationObserver(mark)
    observer.observe(root, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [debugLine])

  const leaveToken = useCallback(() => {
    hoverGeneration.current += 1
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = null
    setHover(null)
  }, [])
  useEffect(() => () => {
    hoverGeneration.current += 1
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
  }, [])
  useEffect(() => {
    if (debugLine === null) leaveToken()
  }, [debugLine, leaveToken])
  const enterToken = useCallback((token: { tokenText: string; tokenElement: HTMLElement }) => {
    leaveToken()
    const expression = token.tokenText.trim()
    if (!DEBUG_HOVER_IDENTIFIER.test(expression) || debugLine === null) return
    const generation = ++hoverGeneration.current
    const bounds = token.tokenElement.getBoundingClientRect()
    setHover({ x: bounds.left, y: bounds.bottom + 6, expression })
    hoverTimer.current = setTimeout(() => {
      debug.hover({ expression, frameId: debug.snapshot.session?.frame?.id }).then((result) => {
        if (hoverGeneration.current !== generation) return
        setHover({ x: bounds.left, y: bounds.bottom + 6, expression, value: result.result, type: result.type })
      }).catch(() => {
        if (hoverGeneration.current === generation) setHover(null)
      })
    }, 250)
  }, [debug, debugLine, leaveToken])

  return (
    <div ref={rootRef} className="relative flex h-full min-h-0 flex-col bg-canvas [&_[data-debug-current-line]]:bg-yellow/15 [&_[data-debug-current-line]]:shadow-[inset_3px_0_var(--sb-yellow)]">
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
        scrollRequest={debugLine === null ? undefined : {
          path: payload.path,
          revision: debugRevision,
          range: { path: payload.path, side: "new", endSide: "new", startLine: debugLine, endLine: debugLine },
          behavior: "smooth-auto"
        }}
        onTokenEnter={enterToken}
        onTokenLeave={leaveToken}
        options={{
          lineNumbers: true,
          stickyHeader: false,
          disableFileHeader: true
        }}
      />
      {hover ? (
        <div
          role="tooltip"
          className="fixed z-50 max-w-80 rounded border border-line bg-panel px-2.5 py-2 font-mono text-[11px] text-text shadow-lg"
          style={{ left: hover.x, top: hover.y }}
        >
          <div className="font-semibold text-text-bright">{hover.expression}</div>
          <div className="mt-1 break-all">{hover.value ?? "Evaluating…"}</div>
          {hover.type ? <div className="mt-1 text-dim">{hover.type}</div> : null}
        </div>
      ) : null}
    </div>
  )
}

function DebugPanel({ model }: { readonly model: DebugSessionModel }) {
  const [open, setOpen] = useState(true)
  const snapshot = model.snapshot
  const session = snapshot.session
  if (!session) return null
  const controls = [
    { action: "pause" as const, label: "Pause", icon: CirclePause, disabled: session.status !== "running" },
    { action: "continue" as const, label: "Continue", icon: CirclePlay, disabled: session.status !== "stopped" },
    { action: "step_over" as const, label: "Step over", icon: StepForward, disabled: session.status !== "stopped" },
    { action: "step_in" as const, label: "Step in", icon: StepForward, disabled: session.status !== "stopped" },
    { action: "step_out" as const, label: "Step out", icon: StepForward, disabled: session.status !== "stopped" },
    { action: "terminate" as const, label: "Terminate", icon: Square, disabled: session.status === "terminated" }
  ]
  return (
    <aside aria-label="Debugger" className="flex w-72 flex-none flex-col border-l border-line bg-panel text-[11px] text-text">
      <button type="button" className="flex h-9 items-center gap-2 border-b border-line px-2 text-left font-medium" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {open ? <ChevronDown className="size-3" aria-hidden /> : <ChevronRight className="size-3" aria-hidden />}
        <Bug className="size-3.5 text-yellow" aria-hidden />
        <span className="flex-1">Debug · {session.status}</span>
      </button>
      {open ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="flex gap-1 border-b border-line p-2">
            {controls.map(({ action, label, icon: Icon, disabled }) => (
              <button key={action} type="button" aria-label={label} title={label} disabled={disabled} onClick={() => { model.control(action).catch(() => {}) }} className="rounded border border-line p-1.5 hover:text-text-bright disabled:opacity-35">
                <Icon className="size-3.5" aria-hidden />
              </button>
            ))}
          </div>
          <DebugSection title="Location">
            <div className="font-mono break-all">{session.frame?.source?.path ?? "No source"}{session.frame ? `:${session.frame.line}` : ""}</div>
            {session.stopReason ? <div className="mt-1 text-dim">{session.stopReason}</div> : null}
          </DebugSection>
          <DebugSection title="Call stack">
            {session.stackFrames.length === 0 ? <span className="text-dim">No frames</span> : session.stackFrames.map((frame) => (
              <div key={frame.id} className="mb-1 font-mono"><span className="text-text-bright">{frame.name}</span><br /><span className="text-dim">{frame.source?.path ?? "unknown"}:{frame.line}</span></div>
            ))}
          </DebugSection>
          <DebugSection title="Variables">
            {snapshot.scopes.flatMap((scope) => snapshot.variables[scope.variablesReference] ?? []).length === 0 ? <span className="text-dim">No variables</span> : snapshot.scopes.map((scope) => (
              <div key={scope.variablesReference} className="mb-2"><div className="mb-1 font-medium text-text-bright">{scope.name}</div>{(snapshot.variables[scope.variablesReference] ?? []).map((variable) => (
                <div key={`${scope.variablesReference}:${variable.name}`} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-2 font-mono"><span className="truncate">{variable.name}</span><span className="truncate text-blue" title={variable.value}>{variable.value}</span></div>
              ))}</div>
            ))}
          </DebugSection>
          <DebugSection title="Breakpoints">
            {Object.entries(session.breakpoints).flatMap(([file, values]) => values.map((point, index) => <div key={`${file}:${point.id ?? index}`} className="truncate font-mono" title={file}>{file}:{point.line ?? "?"}</div>))}
          </DebugSection>
          <DebugSection title="Output"><pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all text-[10px]">{session.output || "No output"}</pre></DebugSection>
          <DebugSection title="Agent actions">
            {snapshot.actions.slice(-20).reverse().map((action) => <div key={action.id} className="mb-1"><span className={action.status === "error" ? "text-red" : action.status === "running" ? "text-yellow" : "text-green"}>{action.status}</span> <span className="font-mono">{action.summary}</span></div>)}
          </DebugSection>
          {snapshot.error ? <div role="alert" className="m-2 rounded border border-red/40 bg-red/10 p-2 text-red">{snapshot.error}</div> : null}
        </div>
      ) : null}
    </aside>
  )
}

function DebugSection({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return <section className="border-b border-line p-2"><h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-dim">{title}</h3>{children}</section>
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
