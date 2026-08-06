import type { ThemeTokens, VsCodeTheme } from "@jingler/core"
import {
  CodeView as PierreCodeViewPrimitive,
  File as PierreFilePrimitive,
  FileDiff as PierreFileDiffPrimitive,
  Virtualizer as PierreVirtualizerPrimitive,
  WorkerPoolContextProvider,
  useWorkerPool,
  type CodeViewHandle,
  type CodeViewCreateEditorOptions,
  type CodeViewItem,
  type DiffLineAnnotation,
  type FileContents,
  type FileDiffMetadata,
  type LineAnnotation,
  type SelectedLineRange,
  type SupportedLanguages
} from "@pierre/diffs/react"
import { Editor as PierreEditorPrimitive } from "@pierre/diffs/editor"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactNode
} from "react"
import {
  useOptionalThemeTokens,
  useThemeSyntax
} from "../theme-provider.js"
import { cn } from "../lib/cn.js"
import type {
  PierreAnnotationMetadata,
  PierreAnnotationPayload
} from "./pierre-annotations.js"
import {
  createPierreThemeAdapter,
  PIERRE_HOST_CLASS,
  type PierreThemeAdapter
} from "./pierre-theme.js"
import {
  fromPierreSelectedLineRange,
  toPierreCodeViewSelection,
  toPierreSelectedLineRange,
  type JinglerLineSelection,
  type PierreCodeViewSelection
} from "./pierre-selection.js"

interface PierreRendererContextValue {
  readonly theme: PierreThemeAdapter
  readonly workerEnabled: boolean
}

const PierreRendererContext = createContext<PierreRendererContextValue | null>(null)

export const usePierreRenderer = (): PierreRendererContextValue => {
  const value = useContext(PierreRendererContext)
  if (value === null) {
    throw new Error("Pierre views must be rendered inside <PierreProvider>")
  }
  return value
}

export interface PierreProviderProps {
  readonly children: ReactNode
  /** Explicit values are useful in Storybook/tests; the app reads ThemeProvider. */
  readonly theme?: VsCodeTheme | null
  readonly tokens?: ThemeTokens | null
  readonly workers?: boolean
  readonly workerCount?: number
  readonly workerCacheSize?: number
  readonly languages?: SupportedLanguages[]
  readonly onWorkerError?: (error: unknown) => void
}

const defaultWorkerCount = (): number => {
  const cores = typeof navigator === "undefined" ? 2 : navigator.hardwareConcurrency
  return Math.max(1, Math.min(4, cores - 1))
}

/** Vite resolves this alias to Pierre's exported module-worker entry. */
export const createPierreHighlightWorker = (): Worker =>
  new Worker(new URL("@jingler/pierre-diffs-worker", import.meta.url), {
    type: "module",
    name: "jingler-pierre-highlighter"
  })

function PierreWorkerThemeSync({
  theme,
  onError
}: {
  readonly theme: string
  readonly onError?: (error: unknown) => void
}) {
  const pool = useWorkerPool()

  useEffect(() => {
    if (pool === undefined) return
    let current = true
    pool.setRenderOptions({ theme }).catch((error) => {
      if (current) onError?.(error)
    })
    return () => {
      current = false
    }
  }, [onError, pool, theme])

  return null
}

export function PierreProvider({
  children,
  theme: explicitTheme,
  tokens: explicitTokens,
  ...props
}: PierreProviderProps) {
  const contextTheme = useThemeSyntax()
  const contextTokens = useOptionalThemeTokens()
  const theme = explicitTheme === undefined ? contextTheme : explicitTheme
  const tokens = explicitTokens === undefined ? contextTokens : explicitTokens

  if (tokens === null) {
    throw new Error("PierreProvider requires Jingler theme tokens")
  }

  return (
    <ResolvedPierreProvider {...props} theme={theme ?? null} tokens={tokens}>
      {children}
    </ResolvedPierreProvider>
  )
}

interface ResolvedPierreProviderProps
  extends Omit<PierreProviderProps, "theme" | "tokens"> {
  readonly theme: VsCodeTheme | null
  readonly tokens: ThemeTokens
}

function ResolvedPierreProvider({
  children,
  theme,
  tokens,
  workers = true,
  workerCount = defaultWorkerCount(),
  workerCacheSize = 160,
  languages = [],
  onWorkerError
}: ResolvedPierreProviderProps) {
  const adapter = useMemo(
    () => createPierreThemeAdapter(theme ?? null, tokens),
    [theme, tokens]
  )
  const workerEnabled = workers && typeof Worker !== "undefined"
  const value = useMemo(
    (): PierreRendererContextValue => ({ theme: adapter, workerEnabled }),
    [adapter, workerEnabled]
  )
  const poolOptions = useMemo(
    () => ({
      workerFactory: createPierreHighlightWorker,
      poolSize: Math.max(1, Math.floor(workerCount)),
      totalASTLRUCacheSize: Math.max(1, Math.floor(workerCacheSize))
    }),
    [workerCacheSize, workerCount]
  )
  const highlighterOptions = useMemo(
    () => ({
      theme: adapter.diffTheme,
      langs: languages
    }),
    [adapter.diffTheme, languages]
  )

  const content = (
    <PierreRendererContext.Provider value={value}>
      {children}
    </PierreRendererContext.Provider>
  )

  if (!workerEnabled) return content

  return (
    <WorkerPoolContextProvider
      poolOptions={poolOptions}
      highlighterOptions={highlighterOptions}
    >
      <PierreWorkerThemeSync theme={adapter.diffTheme} onError={onWorkerError} />
      {content}
    </WorkerPoolContextProvider>
  )
}

export interface PierreRenderOptions {
  readonly lineNumbers?: boolean
  readonly wrap?: boolean
  readonly stickyHeader?: boolean
  readonly collapsed?: boolean
  readonly diffStyle?: "unified" | "split"
  readonly expandUnchanged?: boolean
  readonly collapsedContextThreshold?: number
  readonly hunkSeparators?: "simple" | "metadata" | "line-info" | "line-info-basic"
}

interface PierreAccessibleViewProps {
  readonly label: string
  readonly className?: string
  readonly style?: CSSProperties
}

interface PierreSelectionProps {
  readonly selection?: JinglerLineSelection | null
  readonly onSelectionChange?: (selection: JinglerLineSelection | null) => void
}

const selectedRange = (
  selection: JinglerLineSelection | null | undefined
): SelectedLineRange | null =>
  selection === undefined || selection === null
    ? null
    : toPierreSelectedLineRange(selection)

const baseOptions = (
  adapter: PierreThemeAdapter,
  options: PierreRenderOptions | undefined
) => {
  const overflow: "wrap" | "scroll" = options?.wrap === true ? "wrap" : "scroll"
  return {
    theme: adapter.diffTheme,
    themeType: adapter.themeType,
    unsafeCSS: adapter.unsafeDiffCSS,
    disableLineNumbers: options?.lineNumbers === false,
    overflow,
    diffIndicators: "classic" as const,
    stickyHeader: options?.stickyHeader ?? true,
    collapsed: options?.collapsed ?? false
  }
}

export interface PierreFileViewProps
  extends PierreAccessibleViewProps,
    PierreSelectionProps {
  readonly file: FileContents
  readonly annotations?: LineAnnotation<PierreAnnotationMetadata>[]
  readonly renderAnnotation?: (payload: PierreAnnotationPayload) => ReactNode
  readonly options?: PierreRenderOptions
}

/** Clean source renderer. Diffs use PierreFileDiffView instead. */
export function PierreFileView({
  label,
  className,
  style,
  file,
  annotations,
  renderAnnotation,
  options,
  selection,
  onSelectionChange
}: PierreFileViewProps) {
  const renderer = usePierreRenderer()
  const onSelectionEnd = useCallback(
    (range: SelectedLineRange | null) => {
      onSelectionChange?.(
        range === null
          ? null
          : fromPierreSelectedLineRange(file.name, range)
      )
    },
    [file.name, onSelectionChange]
  )

  return (
    <section
      aria-label={label}
      data-jingler-pierre-view="file"
      className={cn(PIERRE_HOST_CLASS, className)}
      style={style}
    >
      <PierreVirtualizerPrimitive
        className="h-full min-h-0 overflow-auto"
        contentClassName="min-h-full"
      >
        <PierreFilePrimitive<PierreAnnotationMetadata>
          file={file}
          lineAnnotations={annotations}
          selectedLines={selectedRange(selection)}
          disableWorkerPool={!renderer.workerEnabled}
          className="jingler-pierre-primitive"
          options={{
            ...baseOptions(renderer.theme, options),
            enableLineSelection: onSelectionChange !== undefined,
            controlledSelection: true,
            onLineSelectionEnd: onSelectionEnd
          }}
          renderAnnotation={
            renderAnnotation === undefined
              ? undefined
              : (annotation) => renderAnnotation(annotation.metadata.payload)
          }
        />
      </PierreVirtualizerPrimitive>
    </section>
  )
}

export interface PierreFileDiffViewProps
  extends PierreAccessibleViewProps,
    PierreSelectionProps {
  readonly fileDiff: FileDiffMetadata
  /** Give a height-constrained diff its own virtual vertical scroll window. */
  readonly scrollable?: boolean
  readonly annotations?: DiffLineAnnotation<PierreAnnotationMetadata>[]
  readonly renderAnnotation?: (payload: PierreAnnotationPayload) => ReactNode
  readonly options?: PierreRenderOptions
}

export function PierreFileDiffView({
  label,
  className,
  style,
  fileDiff,
  scrollable = false,
  annotations,
  renderAnnotation,
  options,
  selection,
  onSelectionChange
}: PierreFileDiffViewProps) {
  const renderer = usePierreRenderer()
  const onSelectionEnd = useCallback(
    (range: SelectedLineRange | null) => {
      onSelectionChange?.(
        range === null
          ? null
          : fromPierreSelectedLineRange(fileDiff.name, range)
      )
    },
    [fileDiff.name, onSelectionChange]
  )
  const primitive = (
    <PierreFileDiffPrimitive<PierreAnnotationMetadata>
      fileDiff={fileDiff}
      lineAnnotations={annotations}
      selectedLines={selectedRange(selection)}
      disableWorkerPool={!renderer.workerEnabled}
      className="jingler-pierre-primitive"
      options={{
        ...baseOptions(renderer.theme, options),
        diffStyle: options?.diffStyle ?? "unified",
        expandUnchanged: options?.expandUnchanged,
        collapsedContextThreshold: options?.collapsedContextThreshold,
        hunkSeparators: options?.hunkSeparators ?? "line-info",
        enableLineSelection: onSelectionChange !== undefined,
        controlledSelection: true,
        onLineSelectionEnd: onSelectionEnd
      }}
      renderAnnotation={
        renderAnnotation === undefined
          ? undefined
          : (annotation) => renderAnnotation(annotation.metadata.payload)
      }
    />
  )

  return (
    <section
      aria-label={label}
      data-jingler-pierre-view="diff"
      className={cn(PIERRE_HOST_CLASS, className)}
      style={style}
    >
      {scrollable ? (
        <PierreVirtualizerPrimitive
          className="h-full min-h-0 overflow-auto"
          contentClassName="min-h-full"
        >
          {primitive}
        </PierreVirtualizerPrimitive>
      ) : primitive}
    </section>
  )
}

export interface PierreCodeViewProps extends PierreAccessibleViewProps {
  readonly items: readonly CodeViewItem<PierreAnnotationMetadata>[]
  readonly selection?: JinglerLineSelection | null
  readonly onSelectionChange?: (selection: JinglerLineSelection | null) => void
  /** A caller-owned navigation request. Increment revision to repeat a jump. */
  readonly scrollRequest?: {
    readonly path: string
    readonly revision: number
    readonly behavior?: "instant" | "smooth" | "smooth-auto"
  } | null
  /** Reports the last item header above the CodeView viewport. */
  readonly onActivePathChange?: (path: string) => void
  /** Stable Jingler header surface; Pierre's slot implementation stays private. */
  readonly renderHeader?: (
    item: CodeViewItem<PierreAnnotationMetadata>
  ) => ReactNode
  readonly renderAnnotation?: (
    payload: PierreAnnotationPayload,
    item: CodeViewItem<PierreAnnotationMetadata>
  ) => ReactNode
  readonly options?: PierreRenderOptions
}

/** Jingler-owned value emitted by the beta editor integration. */
export interface PierreEditorChange {
  readonly itemId: string
  readonly path: string
  readonly contents: string
}

export interface PierreEditorProps extends PierreCodeViewProps {
  /**
   * The item currently in edit mode. `null` completes the active session;
   * omitted defaults to the first item for a single-file editor.
   */
  readonly editingItemId?: string | null
  /** Fires only when an item's dirty state changes. */
  readonly onDirtyChange?: (itemId: string, dirty: boolean) => void
  /** Fires for each editor document change. */
  readonly onChange?: (change: PierreEditorChange) => void
  /** Fires when Pierre ends a changed edit session. */
  readonly onComplete?: (change: PierreEditorChange) => void
}

interface PierreCodeViewEditorCallbacks {
  readonly create: (
    options: CodeViewCreateEditorOptions<PierreAnnotationMetadata>
  ) => PierreEditorPrimitive<PierreAnnotationMetadata>
  readonly onChange: (
    item: CodeViewItem<PierreAnnotationMetadata>,
    file: FileContents
  ) => void
  readonly onComplete: (
    item: CodeViewItem<PierreAnnotationMetadata>,
    file: FileContents
  ) => void
}

const codeItemPath = (
  item: CodeViewItem<PierreAnnotationMetadata>
): string => item.type === "file" ? item.file.name : item.fileDiff.name

/** Resolve viewport position through CodeView's model, never rendered rows. */
export const pierreActiveCodeItemPath = (
  items: readonly CodeViewItem<PierreAnnotationMetadata>[],
  scrollTop: number,
  getTopForItem: (id: string) => number | undefined
): string | null => {
  if (items.length === 0) return null
  let active = items[0]!
  for (const item of items) {
    const top = getTopForItem(item.id)
    if (top === undefined || top > scrollTop + 1) break
    active = item
  }
  return codeItemPath(active)
}

const useCodeViewSelection = (
  items: readonly CodeViewItem<PierreAnnotationMetadata>[],
  selection: JinglerLineSelection | null | undefined,
  onSelectionChange: PierreCodeViewProps["onSelectionChange"]
) => {
  const upstreamSelection = useMemo(() => {
    if (selection === undefined || selection === null) return null
    const mapped = toPierreCodeViewSelection(selection)
    const item = items.find(
      (candidate) => codeItemPath(candidate) === selection.path
    )
    return item === undefined ? mapped : { ...mapped, id: item.id }
  }, [items, selection])

  const handleSelectionChange = useCallback(
    (next: PierreCodeViewSelection | null) => {
      if (next === null) {
        onSelectionChange?.(null)
        return
      }
      const item = items.find((candidate) => candidate.id === next.id)
      onSelectionChange?.(
        fromPierreSelectedLineRange(
          item === undefined ? next.id : codeItemPath(item),
          next.range
        )
      )
    },
    [items, onSelectionChange]
  )

  return { handleSelectionChange, upstreamSelection }
}

export function PierreCodeView({
  label,
  className,
  style,
  items,
  selection,
  onSelectionChange,
  scrollRequest,
  onActivePathChange,
  renderHeader,
  renderAnnotation,
  options
}: PierreCodeViewProps) {
  return (
    <PierreCodeViewContent
      label={label}
      className={className}
      style={style}
      items={items}
      selection={selection}
      onSelectionChange={onSelectionChange}
      scrollRequest={scrollRequest}
      onActivePathChange={onActivePathChange}
      renderHeader={renderHeader}
      renderAnnotation={renderAnnotation}
      options={options}
    />
  )
}

/**
 * Editable CodeView adapter. Consumers only see Jingler content/dirty events;
 * Pierre's beta Editor constructor and lifecycle remain contained here.
 */
export function PierreEditor({
  items,
  editingItemId,
  onDirtyChange,
  onChange,
  onComplete,
  ...props
}: PierreEditorProps) {
  const dirtyItems = useRef(new Set<string>())
  const activeItemId =
    editingItemId === undefined ? (items[0]?.id ?? null) : editingItemId
  const editableItems = useMemo(
    () =>
      items.map((item) => ({
        ...item,
        edit: item.id === activeItemId
      })),
    [activeItemId, items]
  )
  const create = useCallback(
    (options: CodeViewCreateEditorOptions<PierreAnnotationMetadata>) =>
      new PierreEditorPrimitive<PierreAnnotationMetadata>(options),
    []
  )
  const toChange = useCallback(
    (
      item: CodeViewItem<PierreAnnotationMetadata>,
      file: FileContents
    ): PierreEditorChange => ({
      itemId: item.id,
      path: file.name,
      contents: file.contents
    }),
    []
  )
  const handleChange = useCallback(
    (item: CodeViewItem<PierreAnnotationMetadata>, file: FileContents) => {
      if (!dirtyItems.current.has(item.id)) {
        dirtyItems.current.add(item.id)
        onDirtyChange?.(item.id, true)
      }
      onChange?.(toChange(item, file))
    },
    [onChange, onDirtyChange, toChange]
  )
  const handleComplete = useCallback(
    (item: CodeViewItem<PierreAnnotationMetadata>, file: FileContents) => {
      onComplete?.(toChange(item, file))
      if (dirtyItems.current.delete(item.id)) {
        onDirtyChange?.(item.id, false)
      }
    },
    [onComplete, onDirtyChange, toChange]
  )
  const editor = useMemo(
    (): PierreCodeViewEditorCallbacks => ({
      create,
      onChange: handleChange,
      onComplete: handleComplete
    }),
    [create, handleChange, handleComplete]
  )

  return (
    <PierreCodeViewContent {...props} items={editableItems} editor={editor} />
  )
}

interface PierreCodeViewContentProps extends PierreCodeViewProps {
  readonly editor?: PierreCodeViewEditorCallbacks
}

function PierreCodeViewContent({
  label,
  className,
  style,
  items,
  selection,
  onSelectionChange,
  scrollRequest,
  onActivePathChange,
  renderHeader,
  renderAnnotation,
  options,
  editor
}: PierreCodeViewContentProps) {
  const renderer = usePierreRenderer()
  const viewRef = useRef<CodeViewHandle<PierreAnnotationMetadata> | null>(null)
  const lastActivePath = useRef<string | null>(null)
  const lastScrollRevision = useRef<number | null>(null)
  const { handleSelectionChange, upstreamSelection } = useCodeViewSelection(
    items,
    selection,
    onSelectionChange
  )

  useEffect(() => {
    if (scrollRequest === undefined || scrollRequest === null) return
    if (lastScrollRevision.current === scrollRequest.revision) return
    const item = items.find(
      (candidate) => codeItemPath(candidate) === scrollRequest.path
    )
    if (item === undefined) return
    const view = viewRef.current
    if (view === null) return
    view.scrollTo({
      type: "item",
      id: item.id,
      align: "start",
      ...(scrollRequest.behavior === undefined
        ? {}
        : { behavior: scrollRequest.behavior })
    })
    lastScrollRevision.current = scrollRequest.revision
  }, [items, scrollRequest])

  const handleScroll = useCallback(
    (
      scrollTop: number,
      viewer: { getTopForItem(id: string): number | undefined }
    ) => {
      if (onActivePathChange === undefined) return
      const path = pierreActiveCodeItemPath(
        items,
        scrollTop,
        (id) => viewer.getTopForItem(id)
      )
      if (path === null) return
      if (path === lastActivePath.current) return
      lastActivePath.current = path
      onActivePathChange(path)
    },
    [items, onActivePathChange]
  )

  return (
    <section
      aria-label={label}
      data-jingler-pierre-view="code-view"
      className={cn(PIERRE_HOST_CLASS, className)}
      style={style}
    >
      <PierreCodeViewPrimitive<PierreAnnotationMetadata>
        ref={viewRef}
        items={items}
        createEditor={editor?.create}
        onItemEditChange={editor?.onChange}
        onItemEditComplete={editor?.onComplete}
        selectedLines={upstreamSelection}
        onSelectedLinesChange={handleSelectionChange}
        onScroll={onActivePathChange === undefined ? undefined : handleScroll}
        disableWorkerPool={!renderer.workerEnabled}
        className="jingler-pierre-primitive jingler-pierre-code-view"
        options={{
          ...baseOptions(renderer.theme, options),
          diffStyle: options?.diffStyle ?? "unified",
          expandUnchanged: options?.expandUnchanged,
          collapsedContextThreshold: options?.collapsedContextThreshold,
          hunkSeparators: options?.hunkSeparators ?? "line-info",
          enableLineSelection: onSelectionChange !== undefined,
          controlledSelection: true,
          stickyHeaders: options?.stickyHeader ?? true
        }}
        renderCustomHeader={renderHeader}
        renderAnnotation={
          renderAnnotation === undefined
            ? undefined
            : (annotation, item) =>
                renderAnnotation(annotation.metadata.payload, item)
        }
      />
    </section>
  )
}
