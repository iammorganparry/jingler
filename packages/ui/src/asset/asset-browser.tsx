import { useLayoutEffect, type ReactNode } from "react"
import { useMachine } from "@xstate/react"
import { Files, X } from "lucide-react"
import type { AssetFileEntry } from "@jingler/core"
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
  readonly onSelectPath: (path: string) => void
  /** Native PDFs are disabled while a tree sheet or divider covers/moves the canvas. */
  readonly renderCanvas: (nativeAvailable: boolean) => ReactNode
  readonly className?: string
}

/**
 * Persistent repository browser: one Pierre model, one resizable/collapsible
 * navigation surface, and one sibling content canvas for every asset kind.
 */
export function AssetBrowser({
  sessionId,
  entries,
  selectedPath,
  treeLoading = false,
  treeError = null,
  onSelectPath,
  renderCanvas,
  className
}: AssetBrowserProps) {
  const [containerRef, width] = useContainerWidth()
  const theme = useThemeSyntax()
  const tokens = useOptionalThemeTokens()
  const [state, send] = useMachine(assetBrowserMachine, {
    input: { storageKey: `jingler.asset.tree-width.${sessionId}` }
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
    <div className="relative h-full min-h-0 overflow-hidden bg-panel">
      <AssetFileTree
        entries={entries}
        selectedPath={selectedPath}
        onSelectPath={selectPath}
        className="h-full"
      />
      {treeLoading && entries.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-panel/90 text-[11px] text-dim">
          <Spinner size={12} />
          Loading files…
        </div>
      ) : null}
      {treeError !== null ? (
        <div className="absolute inset-x-3 top-3 rounded border border-line bg-surface px-2.5 py-2 text-[11px] text-red">
          {treeError}
        </div>
      ) : null}
    </div>
  )

  return (
    <PierreProvider theme={theme} tokens={tokens ?? FALLBACK_TOKENS}>
      <section
        ref={containerRef}
        aria-label="Asset browser"
        data-testid="asset-browser"
        className={cn("relative flex h-full min-h-0 min-w-0 bg-canvas", className)}
      >
        {!roomy && sheetOpen ? (
          <button
            type="button"
            aria-label="Close repository files"
            onClick={() => send({ type: "CLOSE_TREE" })}
            className="absolute inset-0 z-20 bg-sunken/70"
          />
        ) : null}
        <aside
          aria-label="Repository browser"
          className={cn(
            "min-h-0 flex-none border-r border-line bg-panel",
            roomy
              ? "relative"
              : "absolute inset-y-0 left-0 z-30 flex w-[min(320px,calc(100%-48px))] flex-col shadow-xl",
            !roomy && !sheetOpen && "hidden"
          )}
          style={roomy ? { width: state.context.treeWidth } : undefined}
        >
          {!roomy ? (
            <div className="flex h-8 flex-none items-center justify-between border-b border-line px-2.5">
              <span className="text-[11px] font-medium text-text-bright">Repository files</span>
              <button
                type="button"
                aria-label="Close repository files"
                onClick={() => send({ type: "CLOSE_TREE" })}
                className="flex size-5 items-center justify-center rounded text-dim hover:bg-hover hover:text-text-bright"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </div>
          ) : null}
          <div className="min-h-0 flex-1">{tree}</div>
        </aside>
        {roomy ? (
          <ResizeHandle
            aria-label="Resize repository browser"
            onResizeStart={() => send({ type: "START_RESIZE" })}
            onResizeEnd={() => send({ type: "END_RESIZE" })}
            onResize={(delta) =>
              send({
                type: "RESIZE_TREE",
                delta,
                max: Math.min(
                  assetBrowserTreeLimits.max,
                  Math.max(assetBrowserTreeLimits.min, width - MIN_CANVAS_WIDTH)
                )
              })
            }
          />
        ) : null}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex h-8 flex-none items-center gap-2 border-b border-line bg-panel px-2">
            {!roomy ? (
              <button
                type="button"
                aria-label="Repository files"
                aria-expanded={sheetOpen}
                onClick={() => send({ type: "TOGGLE_TREE" })}
                className={cn(
                  "flex size-6 items-center justify-center rounded text-dim hover:bg-hover hover:text-text-bright",
                  sheetOpen && "bg-selection text-text-bright"
                )}
              >
                <Files className="size-3.5" aria-hidden />
              </button>
            ) : null}
            <span className="min-w-0 truncate font-mono text-[11px] text-text-body">
              {selectedPath ?? "Select a file"}
            </span>
          </div>
          <main
            aria-label={selectedPath === null ? "Asset content" : `${selectedPath} content`}
            data-testid="asset-content-canvas"
            className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-canvas"
          >
            {renderCanvas(nativeAvailable)}
          </main>
        </div>

      </section>
    </PierreProvider>
  )
}
