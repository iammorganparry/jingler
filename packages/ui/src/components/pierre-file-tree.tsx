import {
  prepareFileTreeInput,
  preparePresortedFileTreeInput,
  type FileTree,
  type FileTreeCompositionOptions,
  type FileTreeDensity,
  type FileTreeIcons,
  type FileTreePreparedInput,
  type FileTreeSearchMode
} from "@pierre/trees"
import {
  FileTree as PierreFileTreePrimitive,
  useFileTree
} from "@pierre/trees/react"
import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject
} from "react"
import { cn } from "../lib/cn.js"
import {
  canonicalPierrePath,
  createPierreGitStatusEntries,
  type JinglerFileStatus
} from "../diff/pierre-model.js"
import { usePierreRenderer } from "../diff/pierre-provider.js"

const DEFAULT_ICONS: FileTreeIcons = {
  set: "complete",
  colored: true
}

const canonicalPaths = (paths: readonly string[]): string[] =>
  [...new Set(paths.map(canonicalPierrePath))]

const pathsEqual = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((path, index) => path === right[index])

export interface PrepareJinglerFileTreeOptions {
  readonly presorted?: boolean
  readonly flattenEmptyDirectories?: boolean
}

/** Prepare once outside hot render paths when a repository tree is large. */
export const prepareJinglerFileTreeInput = (
  paths: readonly string[],
  options: PrepareJinglerFileTreeOptions = {}
): FileTreePreparedInput => {
  const normalized = canonicalPaths(paths)
  return options.presorted === true
    ? preparePresortedFileTreeInput(normalized)
    : prepareFileTreeInput(normalized, {
        flattenEmptyDirectories: options.flattenEmptyDirectories
      })
}

export interface PierreFileTreeProps {
  readonly paths: readonly string[]
  readonly gitStatus?: ReadonlyArray<{
    readonly path: string
    readonly status: JinglerFileStatus
  }>
  readonly selectedPaths?: readonly string[]
  readonly focusedPath?: string
  /** null closes search; a string opens it and updates the model query. */
  readonly searchQuery?: string | null
  readonly searchable?: boolean
  readonly searchMode?: FileTreeSearchMode
  readonly icons?: FileTreeIcons
  readonly composition?: FileTreeCompositionOptions
  readonly initialExpansion?: "closed" | "open" | number
  readonly initialExpandedPaths?: readonly string[]
  readonly flattenEmptyDirectories?: boolean
  readonly presorted?: boolean
  readonly density?: FileTreeDensity
  readonly itemHeight?: number
  readonly overscan?: number
  readonly stickyFolders?: boolean
  readonly ariaLabel?: string
  readonly id?: string
  readonly className?: string
  readonly style?: CSSProperties
  readonly onSelectionChange?: (paths: readonly string[]) => void
  readonly onSearchChange?: (query: string | null) => void
}

interface TreeCallbacks {
  readonly selection: RefObject<PierreFileTreeProps["onSelectionChange"]>
  readonly search: RefObject<PierreFileTreeProps["onSearchChange"]>
  readonly syncingSelection: RefObject<boolean>
}

const usePierreFileTreeModel = (
  props: PierreFileTreeProps,
  callbacks: TreeCallbacks
): FileTree => {
  const [initialPaths] = useState(() => canonicalPaths(props.paths))
  const [preparedInput] = useState(() =>
    prepareJinglerFileTreeInput(initialPaths, {
      presorted: props.presorted ?? false,
      flattenEmptyDirectories: props.flattenEmptyDirectories ?? true
    })
  )
  const [gitStatus] = useState(() =>
    createPierreGitStatusEntries(props.gitStatus ?? [])
  )
  const [selectedPaths] = useState(() =>
    props.selectedPaths?.map(canonicalPierrePath)
  )
  const [expandedPaths] = useState(() =>
    (props.initialExpandedPaths ?? []).map(canonicalPierrePath)
  )
  return useFileTree({
    preparedInput,
    initialExpansion: props.initialExpansion ?? "closed",
    initialExpandedPaths: expandedPaths,
    initialSelectedPaths: selectedPaths,
    flattenEmptyDirectories: props.flattenEmptyDirectories ?? true,
    search: props.searchable ?? true,
    fileTreeSearchMode: props.searchMode ?? "hide-non-matches",
    initialSearchQuery: props.searchQuery,
    icons: props.icons ?? DEFAULT_ICONS,
    composition: props.composition,
    gitStatus,
    density: props.density ?? "compact",
    itemHeight: props.itemHeight,
    overscan: props.overscan ?? 12,
    stickyFolders: props.stickyFolders ?? true,
    onSelectionChange: (next) => {
      if (!callbacks.syncingSelection.current) {
        callbacks.selection.current?.(next)
      }
    },
    onSearchChange: (next) => callbacks.search.current?.(next)
  }).model
}

const useTreeDataUpdates = (
  model: FileTree,
  props: PierreFileTreeProps,
  syncingSelection: RefObject<boolean>
): void => {
  const [initialIdentity] = useState(() => ({
    paths: canonicalPaths(props.paths),
    flatten: props.flattenEmptyDirectories ?? true,
    presorted: props.presorted ?? false
  }))
  const currentIdentity = useRef(initialIdentity)
  useLayoutEffect(() => {
    const nextPaths = canonicalPaths(props.paths)
    const nextFlatten = props.flattenEmptyDirectories ?? true
    const nextPresorted = props.presorted ?? false
    if (
      pathsEqual(currentIdentity.current.paths, nextPaths) &&
      currentIdentity.current.flatten === nextFlatten &&
      currentIdentity.current.presorted === nextPresorted
    ) {
      return
    }
    syncingSelection.current = true
    try {
      model.resetPaths({
        preparedInput: prepareJinglerFileTreeInput(nextPaths, {
          presorted: nextPresorted,
          flattenEmptyDirectories: nextFlatten
        })
      })
    } finally {
      syncingSelection.current = false
    }
    currentIdentity.current = {
      paths: nextPaths,
      flatten: nextFlatten,
      presorted: nextPresorted
    }
  }, [
    model,
    props.flattenEmptyDirectories,
    props.paths,
    props.presorted,
    syncingSelection
  ])

  useLayoutEffect(() => {
    model.setGitStatus(createPierreGitStatusEntries(props.gitStatus ?? []))
  }, [model, props.gitStatus])

  useLayoutEffect(() => {
    model.setIcons(props.icons ?? DEFAULT_ICONS)
  }, [model, props.icons])

  useLayoutEffect(() => {
    model.setComposition(props.composition)
  }, [model, props.composition])

  useLayoutEffect(() => {
    if (props.searchQuery === undefined) return
    model.setSearch(props.searchQuery)
  }, [model, props.searchQuery])
}

const useTreeInteractionUpdates = (
  model: FileTree,
  props: PierreFileTreeProps,
  syncingSelection: RefObject<boolean>
): void => {
  useLayoutEffect(() => {
    if (props.selectedPaths === undefined) return
    const wanted = new Set(props.selectedPaths.map(canonicalPierrePath))
    syncingSelection.current = true
    try {
      for (const path of model.getSelectedPaths()) {
        if (!wanted.has(path)) model.getItem(path)?.deselect()
      }
      for (const path of wanted) {
        if (!model.getItem(path)?.isSelected()) model.getItem(path)?.select()
      }
    } finally {
      syncingSelection.current = false
    }
  }, [model, props.paths, props.selectedPaths, syncingSelection])

  useLayoutEffect(() => {
    if (props.focusedPath === undefined) return
    model.scrollToPath(canonicalPierrePath(props.focusedPath), {
      focus: true,
      offset: "nearest"
    })
  }, [model, props.focusedPath, props.paths])
}

/**
 * Model-first Pierre tree. useFileTree runs once; every later prop update goes
 * through the stable model rather than replacing its focus/selection state.
 */
export function PierreFileTree(props: PierreFileTreeProps) {
  const renderer = usePierreRenderer()
  const selectionCallback = useRef(props.onSelectionChange)
  const searchCallback = useRef(props.onSearchChange)
  const syncingSelection = useRef(false)
  selectionCallback.current = props.onSelectionChange
  searchCallback.current = props.onSearchChange

  const model = usePierreFileTreeModel(props, {
    selection: selectionCallback,
    search: searchCallback,
    syncingSelection
  })
  useTreeDataUpdates(model, props, syncingSelection)
  useTreeInteractionUpdates(model, props, syncingSelection)

  const hostStyle = Object.assign({}, renderer.theme.treeStyles, props.style)

  return (
    <PierreFileTreePrimitive
      id={props.id}
      model={model}
      role="region"
      aria-label={props.ariaLabel ?? "Files"}
      data-jingler-pierre-file-tree=""
      className={cn("jingler-pierre-file-tree", props.className)}
      style={hostStyle}
    />
  )
}
