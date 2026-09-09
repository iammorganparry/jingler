import { useLayoutEffect, useMemo, type ReactNode } from "react"
import { useMachine } from "@xstate/react"
import { Files, X } from "lucide-react"
import { extensionToLanguage, type AssetFileEntry } from "@jingler/core"
import { jinglerDark, toTokens } from "@jingler/themes"
import { ResizeHandle } from "../components/resizable.js"
import { Spinner } from "../components/loading.js"
import { useContainerWidth } from "../hooks/use-container-width.js"
import { cn } from "../lib/cn.js"
import { PierreProvider } from "../diff/pierre-provider.js"
import { useOptionalThemeTokens, useThemeSyntax } from "../theme-provider.js"
import { assetBrowserMachine, assetBrowserTreeLimits } from "./asset-browser-machine.js"
import { AssetFileTree } from "./asset-file-tree.js"

const ROOMY_MIN_WIDTH = 680
const MIN_CANVAS_WIDTH = 360
const FALLBACK_TOKENS = toTokens(jinglerDark)

export interface AssetBrowserProps {
  readonly sessionId: string
  readonly entries: readonly AssetFileEntry[]
  readonly selectedPath: string | null
  readonly treeLoading?: boolean
  readonly treeError?: string | null
  readonly onRetryTree?: () => void
  readonly onSelectPath: (path: string) => void
  /** Native PDFs are disabled while a tree sheet or divider covers/moves the canvas. */
  readonly renderCanvas: (nativeAvailable: boolean) => ReactNode
  /** Optional workspace-level controls above every asset canvas. */
  readonly toolbar?: ReactNode
  readonly hideTree?: boolean
  readonly className?: string
}

export interface AssetRepositoryTreeProps {
  readonly entries: readonly AssetFileEntry[]
  readonly selectedPath: string | null
  readonly treeLoading?: boolean
  readonly treeError?: string | null
  readonly onRetryTree?: () => void
  readonly onSelectPath: (path: string) => void
}

function RepositoryTree({
  entries,
  selectedPath,
  treeLoading = false,
  treeError = null,
  onRetryTree,
  onSelectPath
}: AssetRepositoryTreeProps) {
  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-panel">
      <AssetFileTree entries={entries} selectedPath={selectedPath} onSelectPath={onSelectPath} className="h-full" />
      {treeLoading && entries.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 bg-panel/90 text-[11px] text-dim">
          <Spinner size={12} /> Loading files…
        </div>
      ) : null}
      {treeError !== null ? (
        <div className="absolute inset-x-3 top-3 flex items-center gap-2 rounded border border-line bg-surface px-2.5 py-2 text-[11px] text-red">
          <span className="min-w-0 flex-1">{treeError}</span>
          {onRetryTree ? <button type="button" onClick={onRetryTree} className="flex-none rounded border border-line px-2 py-1 text-text-body hover:bg-hover">Retry</button> : null}
        </div>
      ) : null}
    </div>
  )
}

export function AssetRepositoryTree(props: AssetRepositoryTreeProps) {
  const theme = useThemeSyntax()
  const tokens = useOptionalThemeTokens()
  const languages = useMemo(
    () => [...new Set(props.entries.map((entry) => extensionToLanguage(entry.path)).filter((language): language is string => language !== null))],
    [props.entries]
  )
  return (
    <PierreProvider theme={theme} tokens={tokens ?? FALLBACK_TOKENS} languages={languages}>
      <RepositoryTree {...props} />
    </PierreProvider>
  )
}

function AssetContent({
  toolbar,
  showTreeToggle,
  sheetOpen,
  selectedPath,
  nativeAvailable,
  onToggleTree,
  renderCanvas
}: {
  toolbar?: ReactNode
  showTreeToggle: boolean
  sheetOpen: boolean
  selectedPath: string | null
  nativeAvailable: boolean
  onToggleTree: () => void
  renderCanvas: (nativeAvailable: boolean) => ReactNode
}) {
  const floating = toolbar === undefined
  const toggle = (
    <button
      type="button"
      aria-label="Repository files"
      aria-expanded={sheetOpen}
      title="Repository files"
      onClick={onToggleTree}
      className={cn(
        floating
          ? "absolute left-2 top-2 z-10 flex size-7 items-center justify-center rounded-md bg-panel/80 text-dim shadow-[0_0_0_1px_var(--sb-line)] backdrop-blur-xl hover:bg-surface hover:text-text-bright"
          : "flex size-6 flex-none items-center justify-center rounded-md text-dim hover:bg-surface hover:text-text-bright",
        sheetOpen && "bg-selection text-text-bright"
      )}
    >
      <Files className="size-3.5" aria-hidden />
    </button>
  )
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {toolbar !== undefined ? (
        <div className="flex h-8 flex-none items-center gap-1.5 border-b border-line bg-panel px-2">
          {showTreeToggle ? toggle : null}
          {toolbar}
        </div>
      ) : showTreeToggle ? toggle : null}
      <main
        aria-label={selectedPath === null ? "Asset content" : `${selectedPath} content`}
        data-testid="asset-content-canvas"
        className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-canvas"
      >
        {renderCanvas(nativeAvailable)}
      </main>
    </div>
  )
}

function AssetTreePane({
  hidden,
  roomy,
  sheetOpen,
  treeWidth,
  maxWidth,
  onClose,
  onResizeStart,
  onResizeEnd,
  onResize,
  children
}: {
  hidden: boolean
  roomy: boolean
  sheetOpen: boolean
  treeWidth: number
  maxWidth: number
  onClose: () => void
  onResizeStart: () => void
  onResizeEnd: () => void
  onResize: (delta: number, max: number) => void
  children: ReactNode
}) {
  return (
    <>
      {!hidden && !roomy && sheetOpen ? (
        <button type="button" aria-label="Close repository files" onClick={onClose}
          className="absolute inset-0 z-20 bg-sunken/70" />
      ) : null}
      <aside
        aria-label="Repository browser"
        className={cn(
          "flex min-h-0 flex-none flex-col border-r border-line bg-panel",
          roomy ? "relative" : "absolute inset-y-0 left-0 z-30 w-[min(320px,calc(100%-48px))] shadow-xl",
          hidden || (!roomy && !sheetOpen) ? "hidden" : undefined
        )}
        style={roomy ? { width: treeWidth } : undefined}
      >
        {!roomy ? (
          <div className="flex h-8 flex-none items-center justify-between border-b border-line px-2.5">
            <span className="text-[11px] font-medium text-text-bright">Repository files</span>
            <button type="button" aria-label="Close repository files" onClick={onClose}
              className="flex size-5 items-center justify-center rounded text-dim hover:bg-hover hover:text-text-bright">
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
        ) : null}
        <div className="min-h-0 flex-1">{children}</div>
      </aside>
      {!hidden && roomy ? (
        <ResizeHandle aria-label="Resize repository browser" onResizeStart={onResizeStart}
          onResizeEnd={onResizeEnd} onResize={(delta) => onResize(delta, maxWidth)} />
      ) : null}
    </>
  )
}

/**
 * Persistent repository browser: one Pierre model, one resizable/collapsible
 * navigation surface, and one sibling content canvas for every asset kind.
 */
export function AssetBrowser({
  entries,
  selectedPath,
  treeLoading = false,
  treeError = null,
  onRetryTree,
  onSelectPath,
  renderCanvas,
  toolbar,
  hideTree = false,
  className
}: AssetBrowserProps) {
  function renderRepositoryTree() {
    return (
      <RepositoryTree
        entries={entries}
        selectedPath={selectedPath}
        treeLoading={treeLoading}
        treeError={treeError}
        onRetryTree={onRetryTree}
        onSelectPath={selectPath}
      />
    )
  }

  const [containerRef, width] = useContainerWidth()
  const theme = useThemeSyntax()
  const tokens = useOptionalThemeTokens()
  const languages = useMemo(
    () => [
      ...new Set(
        entries
          .map((entry) => extensionToLanguage(entry.path))
          .filter((language): language is string => language !== null)
      )
    ],
    [entries]
  )
  const [state, send] = useMachine(assetBrowserMachine, {
    input: { storageKey: "jingler.asset.tree-width" }
  })
  const constrained = width > 0 && width < ROOMY_MIN_WIDTH
  const sheetOpen = state.matches({ constrained: "open" })
  const roomy = state.matches("roomy")
  const layoutSettled = constrained ? !roomy : roomy
  const nativeAvailable =
    width > 0 && layoutSettled && !state.context.resizing && !(constrained && sheetOpen)

  useLayoutEffect(() => {
    send({ type: "SET_CONSTRAINED", constrained })
  }, [constrained, send])

  const selectPath = (path: string) => {
    send({ type: "SELECT_PATH" })
    onSelectPath(path)
  }
  const tree = (
    renderRepositoryTree()
  )

  return (
    <PierreProvider
      theme={theme}
      tokens={tokens ?? FALLBACK_TOKENS}
      languages={languages}
    >
      <section
        ref={containerRef}
        aria-label="Asset browser"
        data-testid="asset-browser"
        className={cn("relative flex h-full min-h-0 min-w-0 bg-canvas", className)}
      >
        <AssetTreePane
          hidden={hideTree}
          roomy={roomy}
          sheetOpen={sheetOpen}
          treeWidth={state.context.treeWidth}
          maxWidth={Math.min(
            assetBrowserTreeLimits.max,
            Math.max(assetBrowserTreeLimits.min, width - MIN_CANVAS_WIDTH)
          )}
          onClose={() => send({ type: "CLOSE_TREE" })}
          onResizeStart={() => send({ type: "START_RESIZE" })}
          onResizeEnd={() => send({ type: "END_RESIZE" })}
          onResize={(delta, max) => send({ type: "RESIZE_TREE", delta, max })}
        >
          {tree}
        </AssetTreePane>
        <AssetContent
          toolbar={toolbar}
          showTreeToggle={!hideTree && !roomy}
          sheetOpen={sheetOpen}
          selectedPath={selectedPath}
          nativeAvailable={nativeAvailable}
          onToggleTree={() => send({ type: "TOGGLE_TREE" })}
          renderCanvas={renderCanvas}
        />
      </section>
    </PierreProvider>
  )
}
