/**
 * A session's editor area: the split tree from `editor-layout.ts`, drawn as
 * VS Code-style tab groups.
 *
 * Render cost is the design constraint here:
 * - `EditorGroup`, `SplitNode` and `TabBody` are memoised. The reducers keep
 *   untouched nodes by identity, so switching a tab re-renders one group.
 * - Every callback reaches children through one stable `api` object that reads
 *   the latest props from a ref, so parent re-renders never invalidate memo.
 *   `revision` is the one deliberate escape hatch: bump it (the host passes its
 *   session object) when tab bodies must re-render with new data.
 * - Tab bodies stay mounted while hidden, so switching tabs never remounts a
 *   transcript or a terminal.
 * - Divider drags paint flex weights in the DOM and commit once on release.
 * - Drop-zone hover state lives in each group, not the parent.
 */
import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react"
import { ChevronRight, Plus, X, type LucideIcon } from "lucide-react"
import { cn } from "../lib/cn.js"
import { FileIcon } from "../components/file-icon.js"
import { WidthTierProvider } from "../hooks/width-tier.js"
import {
  activeSurface,
  groupsOf,
  resizedPair,
  type DropEdge,
  type EditorLayout,
  type TabDrag,
  type TabGroup
} from "./editor-layout.js"
import { isSurface, sessionSurfaceKey, type SessionSurface } from "./session-surface-layout.js"
import type { TabLauncherItem } from "./chat-tab-bar.js"
import type { TabBadge } from "./tab-contributions.js"
import { matchNewTabChord } from "./app-shortcuts.js"
import { CommandPalette } from "./command-palette.js"
import type { PaletteItem } from "./command-palette-model.js"

export interface EditorTabMeta {
  readonly label: string
  /** Lucide glyph for chats and views. Files always use the material file icon. */
  readonly icon?: LucideIcon
  /** Breadcrumb trail shown under the tab strip, e.g. `["jingler", "main", "a.ts"]`. */
  readonly crumbs?: ReadonlyArray<string>
  /** The contribution's own badge (plan progress, diff totals). */
  readonly badge?: TabBadge
}

export interface EditorGroupsProps {
  readonly sessionId: string
  readonly layout: EditorLayout
  /** Changes whenever tab bodies must re-render (the host passes its session). */
  readonly revision: unknown
  readonly describe: (surface: SessionSurface) => EditorTabMeta
  readonly renderBody: (surface: SessionSurface, ctx: { readonly focused: boolean; readonly visible: boolean }) => ReactNode
  readonly onActivate: (groupId: string, surface: SessionSurface) => void
  readonly onClose: (groupId: string, surface: SessionSurface) => void
  readonly onDrop: (drag: TabDrag, groupId: string | null, edge: DropEdge, copy: boolean) => void
  readonly onFocusGroup: (groupId: string) => void
  readonly onResize: (splitId: string, index: number, delta: number) => void
  /** The "+" menu at the end of each tab strip. */
  readonly launcherItems?: ReadonlyArray<TabLauncherItem>
  readonly emptyState?: ReactNode
}

type Api = Omit<EditorGroupsProps, "sessionId" | "layout" | "revision" | "emptyState">

/** A drag only drops into the session it came from: the MIME type carries the session. */
export const editorTabMime = (sessionId: string): string =>
  `application/x-jingler-editor-tab-${sessionId.toLowerCase()}`

const readDrag = (e: DragEvent, mime: string): TabDrag | null => {
  try {
    const raw = JSON.parse(e.dataTransfer.getData(mime)) as { surface?: unknown; from?: unknown }
    if (!isSurface(raw.surface)) return null
    return { surface: raw.surface, ...(typeof raw.from === "string" ? { from: raw.from } : {}) }
  } catch {
    return null
  }
}

const OVERLAY: Record<DropEdge, string> = {
  left: "inset-y-0 left-0 w-1/2",
  right: "inset-y-0 right-0 w-1/2",
  top: "inset-x-0 top-0 h-1/2",
  bottom: "inset-x-0 bottom-0 h-1/2",
  center: "inset-0"
}

export function EditorGroups(props: EditorGroupsProps) {
  const latest = useRef<Api>(props)
  latest.current = props
  const api = useMemo<Api>(
    () => ({
      describe: (s) => latest.current.describe(s),
      renderBody: (s, ctx) => latest.current.renderBody(s, ctx),
      onActivate: (g, s) => latest.current.onActivate(g, s),
      onClose: (g, s) => latest.current.onClose(g, s),
      onDrop: (d, g, e, c) => latest.current.onDrop(d, g, e, c),
      onFocusGroup: (g) => latest.current.onFocusGroup(g),
      onResize: (s, i, d) => latest.current.onResize(s, i, d),
      get launcherItems() {
        return latest.current.launcherItems
      }
    }),
    []
  )
  const [commandOpen, setCommandOpen] = useState(false)
  const launchers = props.launcherItems ?? []
  const commandItems = useMemo<ReadonlyArray<PaletteItem>>(
    () => launchers.map((item, index) => ({
      id: `new-tab:${item.id}`,
      kind: "tab" as const,
      group: "New tab",
      label: item.label,
      detail: item.detail,
      icon: item.icon,
      hint: index < 9 ? String(index + 1) : undefined,
      run: item.onSelect
    })),
    [launchers]
  )
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (matchNewTabChord(event)) {
        event.preventDefault()
        setCommandOpen(true)
        return
      }
      if (!commandOpen || event.metaKey || event.ctrlKey || event.altKey) return
      const item = launchers[Number(event.key) - 1]
      if (!item || Number(event.key) < 1 || Number(event.key) > 9) return
      event.preventDefault()
      setCommandOpen(false)
      item.onSelect()
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [commandOpen, launchers])
  const palette = (
    <CommandPalette
      open={commandOpen}
      onOpenChange={setCommandOpen}
      items={commandItems}
      placeholder="Choose a tab type…"
      emptyMessage="No tab types available"
      testId="new-tab-command-menu"
    />
  )
  const mime = editorTabMime(props.sessionId)
  const { root, focusedGroupId } = props.layout
  if (!root) return <><EmptyEditor mime={mime} api={api}>{props.emptyState}</EmptyEditor>{palette}</>
  return (
    <>
      <EditorRow layout={props.layout} focusedGroupId={focusedGroupId} mime={mime} api={api} revision={props.revision} />
      {palette}
    </>
  )
}

interface RowProps {
  readonly layout: EditorLayout
  readonly focusedGroupId: string | null
  readonly mime: string
  readonly api: Api
  readonly revision: unknown
}

const EditorRow = memo(function EditorRow({ layout, focusedGroupId, mime, api, revision }: RowProps) {
  const groups = groupsOf(layout.root)
  const split = layout.root?.type === "split" ? layout.root : null
  const ratios = split?.ratios ?? [1]
  const dragController = useRef<AbortController | null>(null)
  useEffect(() => () => dragController.current?.abort(), [])
  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const container = e.currentTarget.parentElement
    const a = ratios[0]
    const b = ratios[1]
    const first = container?.querySelector<HTMLElement>(':scope > [data-split-child="0"]')
    const second = container?.querySelector<HTMLElement>(':scope > [data-split-child="1"]')
    if (!(container && first && second && split && a !== undefined && b !== undefined)) return
    e.preventDefault()
    const rect = container.getBoundingClientRect()
    if (rect.width === 0) return
    const start = e.clientX
    const handle = e.currentTarget
    handle.setPointerCapture?.(e.pointerId)
    let delta = 0
    dragController.current?.abort()
    const controller = new AbortController()
    dragController.current = controller
    const move = (event: PointerEvent) => {
      const pair = resizedPair(a, b, (event.clientX - start) / rect.width)
      if (!pair) return
      delta = pair[0] - a
      first.style.flexGrow = String(pair[0])
      second.style.flexGrow = String(pair[1])
    }
    const end = () => {
      if (controller.signal.aborted) return
      controller.abort()
      dragController.current = null
      if (handle.hasPointerCapture?.(e.pointerId)) handle.releasePointerCapture(e.pointerId)
      if (delta !== 0) api.onResize(split.id, 0, delta)
    }
    const options = { signal: controller.signal }
    window.addEventListener("pointermove", move, options)
    window.addEventListener("pointerup", end, options)
    window.addEventListener("pointercancel", end, options)
    window.addEventListener("blur", end, options)
    handle.addEventListener("lostpointercapture", end, options)
  }
  return (
    <div data-testid="editor-groups" className="flex min-h-0 min-w-0 flex-1 bg-hairline">
      {groups.map((group, index) => (
        <SplitChild
          key={group.id}
          index={index}
          ratio={ratios[index] ?? 1}
          last={index === groups.length - 1}
          row
          onDividerDown={startDrag}
        >
          <EditorGroup group={group} focused={group.id === focusedGroupId} mime={mime} api={api} revision={revision} />
        </SplitChild>
      ))}
    </div>
  )
})

function SplitChild({
  index,
  ratio,
  last,
  row,
  onDividerDown,
  children
}: {
  index: number
  ratio: number
  last: boolean
  row: boolean
  onDividerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
  children: ReactNode
}) {
  return (
    <>
      <div data-split-child={index} style={{ flexGrow: ratio, flexBasis: 0 }} className="flex min-h-0 min-w-0">
        {children}
      </div>
      {!last && (
        <div
          role="separator"
          aria-orientation={row ? "vertical" : "horizontal"}
          aria-label={`Resize editor group ${index + 1}`}
          data-testid="editor-divider"
          onPointerDown={onDividerDown}
          className={cn(
            "relative z-10 flex-none touch-none bg-hairline hover:bg-blue/50",
            row ? "-mx-px w-[3px] cursor-col-resize" : "-my-px h-[3px] cursor-row-resize"
          )}
        />
      )}
    </>
  )
}

function useDropZone(mime: string, groupId: string | null, api: Api, fixedEdge?: DropEdge) {
  const [edge, setEdge] = useState<DropEdge | null>(null)
  const edgeFor = (_e: DragEvent<HTMLElement>): DropEdge => fixedEdge ?? "center"
  useEffect(() => {
    if (edge === null) return
    const clear = () => setEdge(null)
    window.addEventListener("dragend", clear)
    window.addEventListener("drop", clear)
    return () => {
      window.removeEventListener("dragend", clear)
      window.removeEventListener("drop", clear)
    }
  }, [edge])
  const handlers = {
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!e.dataTransfer.types.includes(mime)) return
      if (fixedEdge) e.stopPropagation()
      e.preventDefault()
      e.dataTransfer.dropEffect = fixedEdge ? "move" : e.altKey ? "copy" : "move"
      const next = edgeFor(e)
      if (next !== edge) setEdge(next)
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (fixedEdge) e.stopPropagation()
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setEdge(null)
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      const drag = readDrag(e, mime)
      setEdge(null)
      if (!drag) return
      if (fixedEdge) e.stopPropagation()
      e.preventDefault()
      api.onDrop(drag, groupId, edgeFor(e), fixedEdge ? false : e.altKey)
    }
  }
  const overlay = edge ? (
    <div data-testid="editor-drop-overlay" aria-hidden className={cn("pointer-events-none absolute z-20 bg-blue/15 ring-2 ring-inset ring-blue", OVERLAY[edge])} />
  ) : null
  return { handlers, overlay, clear: () => setEdge(null) }
}

function EmptyEditor({ mime, api, children }: { mime: string; api: Api; children: ReactNode }) {
  const { handlers, overlay } = useDropZone(mime, null, api)
  return (
    <div data-testid="editor-groups-empty" {...handlers} className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center bg-editor text-[12px] text-dim">
      {children ?? "Nothing open. Pick a chat in the sidebar."}
      {overlay}
    </div>
  )
}

const EditorGroup = memo(function EditorGroup({
  group,
  focused,
  mime,
  api,
  revision
}: {
  group: TabGroup
  focused: boolean
  mime: string
  api: Api
  revision: unknown
}) {
  const groupDrop = useDropZone(mime, group.id, api, "center")
  const tabStripDrop = useDropZone(mime, group.id, api, "center")
  const tabStripHandlers = {
    ...tabStripDrop.handlers,
    onDragOver: (e: DragEvent<HTMLElement>) => {
      groupDrop.clear()
      tabStripDrop.handlers.onDragOver(e)
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      groupDrop.clear()
      tabStripDrop.handlers.onDrop(e)
    }
  }
  const active = activeSurface(group)
  const crumbs = api.describe(active).crumbs ?? []
  return (
    <section
      data-testid="editor-group"
      data-focused={focused || undefined}
      aria-label={`Editor group: ${api.describe(active).label}`}
      onMouseDownCapture={(event) => {
        if (!focused && !(event.target as Element).closest("[data-editor-no-focus]")) api.onFocusGroup(group.id)
      }}
      onFocusCapture={(event) => {
        if (!focused && !(event.target as Element).closest("[data-editor-no-focus]")) api.onFocusGroup(group.id)
      }}
      {...groupDrop.handlers}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-editor"
    >
      <div
        data-testid="editor-tab-strip"
        {...tabStripHandlers}
        className="relative flex h-9 flex-none items-stretch border-b border-hairline bg-sunken"
      >
        <div role="tablist" className="sb-no-scrollbar -mb-px flex min-w-0 flex-1 items-stretch overflow-x-auto">
          {group.tabs.map((surface) => (
            <EditorTab
              key={sessionSurfaceKey(surface)}
              surface={surface}
              groupId={group.id}
              selected={sessionSurfaceKey(surface) === group.active}
              focused={focused}
              mime={mime}
              api={api}
              revision={revision}
            />
          ))}
          <Launcher api={api} />
        </div>
        {tabStripDrop.overlay}
      </div>
      {crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="flex h-6 flex-none items-center gap-1 px-3 text-[11px] text-dim">
          {crumbs.map((crumb, index) => (
            <span key={`${index}-${crumb}`} className="flex min-w-0 items-center gap-1">
              {index > 0 && <ChevronRight className="size-3 flex-none" />}
              <span className={cn("truncate", index === crumbs.length - 1 && "text-muted-foreground")}>{crumb}</span>
            </span>
          ))}
        </nav>
      )}
      <div className="relative flex min-h-0 min-w-0 flex-1">
        {group.tabs.map((surface) => {
          const key = sessionSurfaceKey(surface)
          return <TabBody key={key} surface={surface} visible={key === group.active} focused={focused} api={api} revision={revision} />
        })}
      </div>
      {groupDrop.overlay}
    </section>
  )
})

const EditorTab = memo(function EditorTab({
  surface,
  groupId,
  selected,
  focused,
  mime,
  api
}: {
  surface: SessionSurface
  groupId: string
  selected: boolean
  focused: boolean
  mime: string
  api: Api
  revision: unknown
}) {
  const meta = api.describe(surface)
  const Icon = meta.icon
  return (
    <div
      data-testid={`editor-tab-${surface.kind}-${surface.id}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(mime, JSON.stringify({ surface, from: groupId } satisfies TabDrag))
        e.dataTransfer.effectAllowed = "copyMove"
      }}
      onAuxClick={(e) => e.button === 1 && api.onClose(groupId, surface)}
      className={cn(
        "group flex flex-none items-center border-r border-t-2 border-r-hairline text-xs",
        selected
          ? cn("bg-editor text-text-bright", focused ? "border-t-blue" : "border-t-line")
          : "border-t-transparent text-muted-foreground hover:text-text"
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        title={meta.label}
        onClick={() => api.onActivate(groupId, surface)}
        className="flex items-center gap-1.5 py-1 pl-2.5 pr-1 outline-none"
      >
        {surface.kind === "file" ? (
          <FileIcon path={surface.id} size={12} />
        ) : Icon ? (
          <Icon className={cn("size-3 flex-none", surface.kind === "chat" ? "text-blue" : "text-green")} />
        ) : null}
        <span className="max-w-40 truncate">{meta.label}</span>
        {meta.badge?.kind === "count" && (
          <span className="flex-none rounded bg-surface px-1 font-mono text-[10px] text-muted-foreground">{meta.badge.text}</span>
        )}
        {meta.badge?.kind === "diff" && meta.badge.added + meta.badge.removed > 0 && (
          <span className="flex-none font-mono text-[10px]">
            <span className="text-green">+{meta.badge.added}</span> <span className="text-red">-{meta.badge.removed}</span>
          </span>
        )}
      </button>
      <button
        type="button"
        data-editor-no-focus
        aria-label={`Close ${meta.label}`}
        title={`Close ${meta.label}`}
        onClick={() => api.onClose(groupId, surface)}
        className={cn(
          "mr-1 rounded p-0.5 text-dim outline-none hover:bg-panel hover:text-text focus-visible:opacity-100",
          !selected && "opacity-0 group-hover:opacity-100"
        )}
      >
        <X className="size-3" />
      </button>
    </div>
  )
})

const TabBody = memo(function TabBody({
  surface,
  visible,
  focused,
  api,
  revision
}: {
  surface: SessionSurface
  visible: boolean
  focused: boolean
  api: Api
  revision: unknown
}) {
  return (
    <div
      data-testid={`editor-body-${surface.kind}-${surface.id}`}
      data-surface={sessionSurfaceKey(surface)}
      hidden={!visible}
      className="absolute inset-0 flex min-h-0 min-w-0 flex-col"
    >
      <TabContent
        surface={surface}
        focused={surface.kind === "file" ? false : focused && visible}
        visible={visible}
        api={api}
        revision={revision}
      />
    </div>
  )
})

const TabContent = memo(function TabContent({
  surface,
  focused,
  visible,
  api
}: {
  surface: SessionSurface
  focused: boolean
  visible: boolean
  api: Api
  revision: unknown
}) {
  // Each body measures its own width, so a view split beside a chat lays out for its half.
  return <WidthTierProvider className="flex-col">{api.renderBody(surface, { focused, visible })}</WidthTierProvider>
})

function Launcher({ api }: { api: Api }) {
  const items = api.launcherItems ?? []
  if (items.length === 0) return null
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="New tab"
          title="New tab"
          className="flex flex-none items-center px-2 text-dim outline-none hover:text-text"
        >
          <Plus className="size-3.5" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 flex min-w-[220px] flex-col gap-0.5 rounded-lg border border-line bg-sunken p-1.5 shadow-2xl"
        >
          {items.map((item) => (
            <DropdownMenu.Item
              key={item.id}
              onSelect={item.onSelect}
              data-testid={`new-tab-option-${item.id}`}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-[12.5px] text-text-body outline-none data-[highlighted]:bg-surface data-[highlighted]:text-text-bright"
            >
              <item.icon className="size-3.5 flex-none text-dim" />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
