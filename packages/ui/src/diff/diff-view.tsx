import type {
  CodeViewItem,
  DiffLineAnnotation,
  FileDiffMetadata
} from "@pierre/diffs"
import { jinglerDark, toTokens } from "@jingler/themes"
import { Undo2, X } from "lucide-react"
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react"
import { Button } from "../components/button.js"
import { ClaudeGlyph } from "../components/eyebrow.js"
import { cn } from "../lib/cn.js"
import {
  useOptionalThemeTokens,
  useThemeSyntax
} from "../theme-provider.js"
import {
  createPierreDiffAnnotation,
  PierreAnnotationRegion,
  type PierreAnnotationMetadata,
  type PierreAnnotationPayload,
  type PierreSelectedRangeActionsAnnotation
} from "./pierre-annotations.js"
import {
  createPierreCodeViewItem,
  pierreItemVersion
} from "./pierre-model.js"
import {
  PierreCodeView,
  PierreFileDiffView,
  PierreProvider,
  type PierreRenderOptions
} from "./pierre-provider.js"
import type { JinglerLineSelection } from "./pierre-selection.js"
import type { DiffRow } from "./parse.js"
import {
  parsePierreFileDiffs,
  patchFromDiffRows
} from "./parse.js"

const FALLBACK_TOKENS = toTokens(jinglerDark)

/** Optional interactions for a live worktree diff (the Changes rail). */
export interface DiffActions {
  /** Revert the uncommitted changes in Pierre's side-aware inclusive range. */
  onRevertLines: (selection: JinglerLineSelection) => void
  /** Revert all uncommitted changes to a file. */
  onRevertFile: (path: string) => void
  /** Send a comment about Pierre's side-aware inclusive range to the agent. */
  onComment: (selection: JinglerLineSelection, body: string) => void
}

export interface DiffViewProps {
  /** Structured single-file input. */
  fileDiff?: FileDiffMetadata
  /** Structured multi-file input; CodeView owns virtualization. */
  fileDiffs?: readonly FileDiffMetadata[]
  /** Raw unified patch, converted once to structured Pierre metadata. */
  patch?: string
  /** @deprecated Compatibility input while non-rendering row consumers remain. */
  rows?: ReadonlyArray<DiffRow>
  className?: string
  label?: string
  /** Fill an existing pane by default; compact cards render at natural height. */
  fill?: boolean
  options?: PierreRenderOptions
  /** When provided, Pierre selection and annotation actions are enabled. */
  actions?: DiffActions
  /** Optional controlled Pierre selection for non-review consumers such as Files. */
  selection?: JinglerLineSelection | null
  /** Enables line selection without enabling review annotations or actions. */
  onSelectionChange?: (selection: JinglerLineSelection | null) => void
}

const inputFileDiffs = ({
  fileDiff,
  fileDiffs,
  patch,
  rows
}: Pick<DiffViewProps, "fileDiff" | "fileDiffs" | "patch" | "rows">): readonly FileDiffMetadata[] => {
  if (fileDiff !== undefined) return [fileDiff]
  if (fileDiffs !== undefined) return fileDiffs
  const source = rows === undefined ? (patch ?? "") : patchFromDiffRows(rows)
  return source.trim().length === 0 ? [] : parsePierreFileDiffs(source)
}

const fileDiffContentIdentity = (fileDiff: FileDiffMetadata): string =>
  fileDiff.cacheKey ?? JSON.stringify({
    hunks: fileDiff.hunks,
    deletionLines: fileDiff.deletionLines,
    additionLines: fileDiff.additionLines
  })

const fileDiffRevision = (fileDiffs: readonly FileDiffMetadata[]): number =>
  pierreItemVersion(
    ...fileDiffs.flatMap((fileDiff) => [
      fileDiffContentIdentity(fileDiff),
      fileDiff.prevName,
      fileDiff.name,
      fileDiff.type,
      fileDiff.unifiedLineCount,
      fileDiff.splitLineCount
    ])
  )

const selectionIdentity = (selection: JinglerLineSelection): string =>
  [
    selection.path,
    selection.side,
    selection.startLine,
    selection.endSide,
    selection.endLine
  ].join(":")

const selectedActionsPayload = (
  selection: JinglerLineSelection
): PierreSelectedRangeActionsAnnotation => ({
  id: `diff-actions:${selectionIdentity(selection)}`,
  kind: "selected-range-actions",
  selection,
  actions: [
    { id: "revert", label: "Revert", intent: "danger" },
    { id: "comment", label: "Send to agent", intent: "primary" }
  ]
})

/**
 * Jingler's stable diff surface. Pierre owns parsing, rendering, virtualization,
 * click/drag/Shift selection, highlighting, and old/new line semantics.
 */
export function DiffView({
  fileDiff,
  fileDiffs,
  patch,
  rows,
  className,
  label = "Code changes",
  fill = true,
  options,
  actions,
  selection,
  onSelectionChange
}: DiffViewProps) {
  const theme = useThemeSyntax()
  const tokens = useOptionalThemeTokens()
  const parsed = useMemo(
    () => inputFileDiffs({ fileDiff, fileDiffs, patch, rows }),
    [fileDiff, fileDiffs, patch, rows]
  )
  const revision = useMemo(() => fileDiffRevision(parsed), [parsed])
  const renderOptions = useMemo(
    (): PierreRenderOptions => ({
      ...options,
      stickyHeader: options?.stickyHeader ?? fill,
      diffStyle: options?.diffStyle ?? "unified"
    }),
    [fill, options]
  )
  return (
    <PierreProvider
      theme={theme}
      tokens={tokens ?? FALLBACK_TOKENS}
      workers={fill}
    >
      <DiffViewContent
        revision={revision}
        fileDiffs={parsed}
        className={className}
        label={label}
        fill={fill}
        options={renderOptions}
        actions={actions}
        selection={selection}
        onSelectionChange={onSelectionChange}
      />
    </PierreProvider>
  )
}

function useDiffSelectionState() {
  const [selection, setSelection] = useState<JinglerLineSelection | null>(null)
  const [body, setBody] = useState("")
  const clear = useCallback(() => {
    setSelection(null)
    setBody("")
  }, [])
  const onSelectionChange = useCallback((next: JinglerLineSelection | null) => {
    setSelection(next)
    setBody("")
  }, [])
  return { selection, body, setBody, clear, onSelectionChange }
}

function usePierreDiffModel(
  fileDiffs: readonly FileDiffMetadata[],
  selection: JinglerLineSelection | null
) {
  const activeSelection = useMemo(
    () =>
      selection !== null && fileDiffs.some((candidate) => candidate.name === selection.path)
        ? selection
        : null,
    [fileDiffs, selection]
  )
  const payload = useMemo(
    () => activeSelection === null ? null : selectedActionsPayload(activeSelection),
    [activeSelection]
  )
  const annotation = useMemo(
    () => payload === null ? null : createPierreDiffAnnotation(payload),
    [payload]
  )
  const items = useMemo(
    () =>
      fileDiffs.map((candidate) =>
        createPierreCodeViewItem<PierreAnnotationMetadata>({
          type: "diff",
          fileDiff: candidate,
          annotations:
            annotation !== null && activeSelection?.path === candidate.name
              ? [annotation]
              : undefined,
          version: pierreItemVersion(
            fileDiffContentIdentity(candidate),
            candidate.name,
            payload?.id
          )
        })
      ),
    [activeSelection?.path, annotation, fileDiffs, payload?.id]
  )
  return { activeSelection, annotation, items }
}

function useSelectedRangeRenderer(
  actions: DiffActions | undefined,
  body: string,
  setBody: (body: string) => void,
  clear: () => void
) {
  return useCallback(
    (candidate: PierreAnnotationPayload) => {
      if (actions === undefined || candidate.kind !== "selected-range-actions") return null
      const comment = () => {
        const trimmed = body.trim()
        if (trimmed.length === 0) return
        actions.onComment(candidate.selection, trimmed)
        clear()
      }
      return (
        <SelectedRangeActions
          payload={candidate}
          body={body}
          onBodyChange={setBody}
          onCancel={clear}
          onRevert={() => {
            actions.onRevertLines(candidate.selection)
            clear()
          }}
          onComment={comment}
        />
      )
    },
    [actions, body, clear, setBody]
  )
}

function DiffViewContent({
  revision,
  fileDiffs,
  className,
  label,
  fill,
  options,
  actions,
  selection,
  onSelectionChange
}: {
  readonly revision: number
  readonly fileDiffs: readonly FileDiffMetadata[]
  readonly className: string | undefined
  readonly label: string
  readonly fill: boolean
  readonly options: PierreRenderOptions
  readonly actions: DiffActions | undefined
  readonly selection: JinglerLineSelection | null | undefined
  readonly onSelectionChange: ((selection: JinglerLineSelection | null) => void) | undefined
}) {
  const state = useDiffSelectionState()
  useEffect(() => state.clear(), [revision, state.clear])
  useEffect(() => {
    if (
      selection !== null &&
      selection !== undefined &&
      !fileDiffs.some((candidate) => candidate.name === selection.path)
    ) {
      onSelectionChange?.(null)
    }
  }, [fileDiffs, onSelectionChange, selection])
  const activeSelection = actions === undefined ? (selection ?? null) : state.selection
  const handleSelectionChange = actions === undefined ? onSelectionChange : state.onSelectionChange
  const model = usePierreDiffModel(fileDiffs, activeSelection)
  const renderAnnotation = useSelectedRangeRenderer(actions, state.body, state.setBody, state.clear)
  return (
    <div
      className={cn(
        "relative flex min-w-0 flex-col bg-editor",
        fill ? "h-full min-h-0" : "h-auto",
        className
      )}
    >
      <FileDiffActions
        fileDiffs={fileDiffs}
        actions={actions}
        onActionComplete={state.clear}
      />
      <PierreDiffRenderer
        label={label}
        fill={fill}
        fileDiffs={fileDiffs}
        items={model.items}
        annotation={model.annotation}
        selection={handleSelectionChange === undefined ? undefined : model.activeSelection}
        onSelectionChange={handleSelectionChange}
        renderAnnotation={actions === undefined ? undefined : renderAnnotation}
        options={options}
      />
    </div>
  )
}

function FileDiffActions({
  fileDiffs,
  actions,
  onActionComplete
}: {
  readonly fileDiffs: readonly FileDiffMetadata[]
  readonly actions: DiffActions | undefined
  readonly onActionComplete: () => void
}) {
  if (actions === undefined || fileDiffs.length === 0) return null
  return (
    <div
      role="toolbar"
      aria-label="File diff actions"
      className="flex flex-none items-center gap-1 overflow-x-auto border-b border-hairline bg-surface px-2 py-1"
    >
      {fileDiffs.map((candidate) => (
        <button
          key={candidate.name}
          type="button"
          aria-label={`Revert ${candidate.name}`}
          onClick={() => {
            actions.onRevertFile(candidate.name)
            onActionComplete()
          }}
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] text-red opacity-80 hover:bg-red/10"
        >
          <Undo2 size={11} />
          Revert {candidate.name.split("/").at(-1)}
        </button>
      ))}
    </div>
  )
}

function PierreDiffRenderer({
  label,
  fill,
  fileDiffs,
  items,
  annotation,
  selection,
  onSelectionChange,
  renderAnnotation,
  options
}: {
  readonly label: string
  readonly fill: boolean
  readonly fileDiffs: readonly FileDiffMetadata[]
  readonly items: readonly CodeViewItem<PierreAnnotationMetadata>[]
  readonly annotation: DiffLineAnnotation<PierreAnnotationMetadata> | null
  readonly selection: JinglerLineSelection | null | undefined
  readonly onSelectionChange: ((selection: JinglerLineSelection | null) => void) | undefined
  readonly renderAnnotation: ((payload: PierreAnnotationPayload) => ReactNode) | undefined
  readonly options: PierreRenderOptions
}) {
  if (fileDiffs.length === 0) {
    return (
      <section
        aria-label={label}
        data-jingler-pierre-view="empty-diff"
        className="min-h-0 flex-1 bg-editor"
      />
    )
  }
  const className = cn("min-h-0 min-w-0 flex-1", !fill && "h-auto")
  if (fileDiffs.length === 1) {
    return (
      <PierreFileDiffView
        label={label}
        className={className}
        scrollable={fill}
        fileDiff={fileDiffs[0]!}
        annotations={annotation === null ? undefined : [annotation]}
        selection={selection}
        onSelectionChange={onSelectionChange}
        renderAnnotation={renderAnnotation}
        options={options}
      />
    )
  }
  return (
    <PierreCodeView
      label={label}
      className={className}
      items={items}
      selection={selection}
      onSelectionChange={onSelectionChange}
      renderAnnotation={renderAnnotation}
      options={options}
    />
  )
}

function SelectedRangeActions({
  payload,
  body,
  onBodyChange,
  onCancel,
  onRevert,
  onComment
}: {
  readonly payload: PierreSelectedRangeActionsAnnotation
  readonly body: string
  readonly onBodyChange: (body: string) => void
  readonly onCancel: () => void
  readonly onRevert: () => void
  readonly onComment: () => void
}) {
  const { selection } = payload
  const start = `${selection.side} L${selection.startLine}`
  const end = `${selection.endSide} L${selection.endLine}`
  const range = start === end ? start : `${start}–${end}`

  return (
    <PierreAnnotationRegion
      label={`Actions for ${selection.path}, ${range}`}
      payload={payload}
      className="flex flex-col gap-2 p-2.5"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2 text-[11px]">
        <span className="truncate font-mono text-blue">
          {selection.path.split("/").at(-1)} {range}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          aria-label="Cancel selected range"
          onClick={onCancel}
          className="text-dim hover:text-text"
        >
          <X size={13} />
        </button>
      </div>
      <textarea
        value={body}
        onChange={(event) => onBodyChange(event.target.value)}
        placeholder="Ask the agent to fix this…"
        rows={2}
        className="w-full resize-none rounded-md border border-line bg-sunken px-2 py-1.5 font-sans text-[12px] text-text-body outline-none placeholder:text-dim focus-visible:border-blue"
      />
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button
          variant="danger"
          size="sm"
          className="gap-1.5"
          onClick={onRevert}
        >
          <Undo2 size={12} />
          Revert
        </Button>
        <div className="flex-1" />
        <Button
          size="sm"
          aria-label="Send to agent"
          className="gap-1.5"
          disabled={body.trim().length === 0}
          onClick={onComment}
        >
          <ClaudeGlyph />
          Send to agent
        </Button>
      </div>
    </PierreAnnotationRegion>
  )
}
