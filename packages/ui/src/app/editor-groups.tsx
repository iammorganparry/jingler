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
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react"
import { createPortal } from "react-dom"
import { Ellipsis, MessageSquarePlus, Plus, X, type LucideIcon } from "lucide-react"
import { Button } from "../components/button.js"
import { Breadcrumb } from "../components/breadcrumb.js"
import { cn } from "../lib/cn.js"
import { FileIcon } from "../components/file-icon.js"
import { WidthTierProvider } from "../hooks/width-tier.js"
import {
  activeSurface,
  groupsOf,
  resizedPair,
  MIN_GROUP_PX,
  type DropEdge,
  type EditorLayout,
  type EditorNode,
  type EditorSplit,
  type TabDrag,
  type TabGroup
} from "./editor-layout.js"
import { isSurface, sessionSurfaceKey, type SessionSurface } from "./session-surface-layout.js"
import type { TabLauncherItem } from "./chat-tab-bar.js"
import type { TabBadge } from "./tab-contributions.js"
import { matchNewTabChord } from "./app-shortcuts.js"
import { DropZoneOverlay, resolveDropEdge } from "./drop-zone-overlay.js"
import { CommandPalette } from "./command-palette.js"
import type { PaletteItem } from "./command-palette-model.js"
import { ChatLaneHeader, SubagentLaneViewContext, type ChatLaneHeaderChat } from "./chat-lane-header.js"

/** Host-provided marker (`● N agent edits`) shown at the right of a file tab's breadcrumb. */
export const AgentEditsMarkerContext = createContext<(sessionId: string, path: string) => ReactNode>(() => null)

/** The visible file tab's slot in the breadcrumb row; its body portals Diff/Edit, Follow, Focus controls there. */
export const FileHeaderSlotContext = createContext<HTMLElement | null>(null)

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
  readonly onOpenCheckpoints?: (trigger: HTMLButtonElement | null) => void
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
  readonly onResize: (splitId: string, index: number, delta: number, containerWidth?: number) => void
  /** The "+" menu at the end of each tab strip. */
  readonly launcherItems?: ReadonlyArray<TabLauncherItem>
  readonly emptyState?: ReactNode
  readonly onCreateChat?: (sessionId: string) => void
  readonly followAgent?: boolean
  readonly onToggleFollowAgent?: (enabled: boolean) => void
  /** Subagent chip for one chat, rendered in that chat group's lane header. */
  readonly renderSubagentChip?: (chatId: string) => ReactNode
}

type Api = Omit<EditorGroupsProps, "layout" | "revision" | "emptyState"> & { readonly sessionId: string }

/** A drag only drops into the session it came from: the MIME type carries the session. */
export const editorTabMime = (sessionId: string): string =>
  `application/x-jingler-editor-tab-${sessionId.toLowerCase()}`

export const editorFileMime = "application/x-jingler-editor-file"

const readDrag = (e: DragEvent, mime: string): TabDrag | null => {
  try {
    const raw = JSON.parse(e.dataTransfer.getData(mime)) as { surface?: unknown; from?: unknown }
    if (!isSurface(raw.surface)) return null
    return { surface: raw.surface, ...(typeof raw.from === "string" ? { from: raw.from } : {}) }
  } catch {
    return null
  }
}

export function EditorGroups(props: EditorGroupsProps) {
  const latest = useRef<Api>(props)
  latest.current = props
  const api = useMemo<Api>(
    () => ({
      sessionId: props.sessionId,
      describe: (s) => latest.current.describe(s),
      renderBody: (s, ctx) => latest.current.renderBody(s, ctx),
      onActivate: (g, s) => latest.current.onActivate(g, s),
      onClose: (g, s) => latest.current.onClose(g, s),
      onDrop: (d, g, e, c) => latest.current.onDrop(d, g, e, c),
      onFocusGroup: (g) => latest.current.onFocusGroup(g),
      onResize: (s, i, d, w) => latest.current.onResize(s, i, d, w),
      get onOpenCheckpoints() { return latest.current.onOpenCheckpoints },
      get launcherItems() {
        return latest.current.launcherItems
      },
      get followAgent() { return latest.current.followAgent },
      get onToggleFollowAgent() { return latest.current.onToggleFollowAgent },
      get onCreateChat() { return latest.current.onCreateChat },
      get renderSubagentChip() { return latest.current.renderSubagentChip }
    }),
    [props.sessionId]
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
  const groupHosts = useRef(new Map<string, HTMLDivElement>()).current
  const groups = groupsOf(root)
  const groupIds = new Set(groups.map((group) => group.id))
  for (const id of groupHosts.keys()) if (!groupIds.has(id)) groupHosts.delete(id)
  for (const group of groups) {
    if (groupHosts.has(group.id)) continue
    const host = document.createElement("div")
    host.className = "flex min-h-0 min-w-0 flex-1"
    groupHosts.set(group.id, host)
  }
  if (!root) return <><EmptyEditor mime={mime} api={api}>{props.emptyState}</EmptyEditor>{palette}</>
  const rootSplit: EditorSplit = root.type === "split"
    ? root
    : { type: "split", id: "root", axis: "row", children: [root], ratios: [1] }
  return (
    <>
      <div data-testid="editor-groups" className="flex min-h-0 min-w-0 flex-1 bg-hairline">
        <SplitNode split={rootSplit} focusedGroupId={focusedGroupId} mime={mime} api={api} revision={props.revision} groupHosts={groupHosts} />
        {groups.map((group) => createPortal(
          <EditorGroup
            group={group}
            focused={group.id === focusedGroupId}
            mime={mime}
            api={api}
            revision={props.revision}
          />,
          groupHosts.get(group.id)!,
          group.id
        ))}
      </div>
      {palette}
    </>
  )
}

interface NodeProps {
  readonly focusedGroupId: string | null
  readonly mime: string
  readonly api: Api
  readonly revision: unknown
  readonly groupHosts: ReadonlyMap<string, HTMLDivElement>
}

function EditorNodeView({ node, ...rest }: NodeProps & { readonly node: EditorNode }) {
  return node.type === "group" ? (
    <GroupSlot host={rest.groupHosts.get(node.id)!} />
  ) : (
    <SplitNode split={node} {...rest} />
  )
}

function GroupSlot({ host }: { readonly host: HTMLDivElement }) {
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1"
      ref={(node) => {
        if (node && host.parentElement !== node) node.appendChild(host)
      }}
    />
  )
}

const SplitNode = memo(function SplitNode({ split, ...rest }: NodeProps & { readonly split: EditorSplit }) {
  const row = split.axis === "row"
  const dragController = useRef<AbortController | null>(null)
  useEffect(() => () => dragController.current?.abort(), [])
  const startDrag = (index: number) => (e: ReactPointerEvent<HTMLDivElement>) => {
    const container = e.currentTarget.parentElement
    const a = split.ratios[index]
    const b = split.ratios[index + 1]
    const first = container?.querySelector<HTMLElement>(`:scope > [data-split-child="${index}"]`)
    const second = container?.querySelector<HTMLElement>(`:scope > [data-split-child="${index + 1}"]`)
    if (!(container && first && second && a !== undefined && b !== undefined)) return
    e.preventDefault()
    const rect = container.getBoundingClientRect()
    const size = row ? rect.width : rect.height
    if (size === 0) return
    const start = row ? e.clientX : e.clientY
    const handle = e.currentTarget
    handle.setPointerCapture?.(e.pointerId)
    let delta = 0
    dragController.current?.abort()
    const controller = new AbortController()
    dragController.current = controller
    const move = (event: PointerEvent) => {
      const pair = resizedPair(a, b, ((row ? event.clientX : event.clientY) - start) / size)
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
      if (delta !== 0) rest.api.onResize(split.id, index, delta, size)
    }
    const options = { signal: controller.signal }
    window.addEventListener("pointermove", move, options)
    window.addEventListener("pointerup", end, options)
    window.addEventListener("pointercancel", end, options)
    window.addEventListener("blur", end, options)
    handle.addEventListener("lostpointercapture", end, options)
  }
  return (
    <div data-testid={`editor-split-${split.axis}`} className={cn("flex min-h-0 min-w-0 flex-1", !row && "flex-col")}>
      {split.children.map((child, index) => (
        <SplitChild key={child.id} index={index} ratio={split.ratios[index] ?? 0} last={index === split.children.length - 1} row={row} onDividerDown={startDrag(index)}>
          <EditorNodeView node={child} {...rest} />
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
            row ? "-mx-1 w-px cursor-col-resize box-content px-1" : "-my-1 h-px cursor-row-resize box-content py-1"
          )}
        />
      )}
    </>
  )
}

function useDropZone(
  mime: string,
  groupId: string | null,
  api: Api,
  fixedEdge?: DropEdge,
  rejectCenterFiles = false
) {
  const [edge, setEdge] = useState<DropEdge | null>(null)
  const [rejected, setRejected] = useState(false)
  const edgeFor = (event: DragEvent<HTMLElement>): DropEdge =>
    fixedEdge ?? (groupId === null ? "center" : resolveDropEdge(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY))
  const clear = useCallback(() => {
    setEdge(null)
    setRejected(false)
  }, [])
  useEffect(() => {
    if (edge === null) return
    window.addEventListener("dragend", clear)
    window.addEventListener("drop", clear)
    return () => {
      window.removeEventListener("dragend", clear)
      window.removeEventListener("drop", clear)
    }
  }, [clear, edge])
  const rejectsFile = (event: DragEvent<HTMLElement>, next: DropEdge) =>
    rejectCenterFiles && next === "center" && event.dataTransfer.types.includes(editorFileMime)
  const handlers = {
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes(mime)) return
      if (fixedEdge) event.stopPropagation()
      event.preventDefault()
      const next = edgeFor(event)
      const reject = rejectsFile(event, next)
      event.dataTransfer.dropEffect = reject ? "none" : fixedEdge ? "move" : event.altKey ? "copy" : "move"
      setRejected(reject)
      if (next !== edge) setEdge(next)
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (fixedEdge) event.stopPropagation()
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) clear()
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      const drag = readDrag(event, mime)
      const next = edgeFor(event)
      clear()
      if (!drag) return
      if (fixedEdge) event.stopPropagation()
      event.preventDefault()
      if (rejectCenterFiles && next === "center" && drag.surface.kind === "file") return
      api.onDrop(drag, groupId, next, fixedEdge ? false : event.altKey)
    }
  }
  const overlay = edge ? <DropZoneOverlay edge={edge} rejected={rejected} zones={!fixedEdge && groupId !== null} /> : null
  return { handlers, overlay, clear }
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
  const [width, setWidth] = useState(0)
  const sectionRef = useRef<HTMLElement>(null)
  const resolveSubagentView = useContext(SubagentLaneViewContext)
  const renderAgentEdits = useContext(AgentEditsMarkerContext)
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null)
  
  useEffect(() => {
    const section = sectionRef.current
    if (!section || typeof ResizeObserver === "undefined") return
    
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setWidth(entry.contentRect.width)
    })
    
    observer.observe(section)
    return () => observer.disconnect()
  }, [])
  
  const collapsed = width > 0 && width < MIN_GROUP_PX
  const active = activeSurface(group)
  const groupDrop = useDropZone(mime, group.id, api, undefined, active.kind === "chat")
  const tabStripDrop = useDropZone(mime, group.id, api, "center")
  const tabStripHandlers = {
    ...tabStripDrop.handlers,
    onDragOver: (event: DragEvent<HTMLElement>) => {
      groupDrop.clear()
      tabStripDrop.handlers.onDragOver(event)
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      groupDrop.clear()
      tabStripDrop.handlers.onDrop(event)
    }
  }
  const crumbs = api.describe(active).crumbs ?? []
  
  // Check if all tabs are chats
  const allChats = group.tabs.every(tab => tab.kind === "chat")
  const chatTabs = useMemo(() => 
    allChats ? group.tabs.filter((tab): tab is Extract<SessionSurface, { kind: "chat" }> => tab.kind === "chat") : [],
    [allChats, group.tabs]
  )
  
  return (
    <section
      ref={sectionRef}
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
      {allChats ? (
        <div className="relative flex h-10 flex-none items-stretch border-b border-hairline bg-sunken" {...tabStripHandlers}>
          <ChatLaneHeader
            chats={chatTabs.map((chat): ChatLaneHeaderChat => ({
              id: chat.id,
              title: api.describe(chat).label,
              running: false
            }))}
            activeChatId={(active as Extract<SessionSurface, { kind: "chat" }>).id}
            onSelectChat={(id) => {
              const chat = chatTabs.find(c => c.id === id)
              if (chat) api.onActivate(group.id, chat)
            }}
            onCloseChat={(id) => {
              const chat = chatTabs.find((c) => c.id === id)
              if (chat) api.onClose(group.id, chat)
            }}
            onCreateChat={api.onCreateChat ? () => api.onCreateChat?.(api.sessionId) : undefined}
            followAgent={api.followAgent}
            onToggleFollowAgent={api.onToggleFollowAgent}
            subagentSlot={api.renderSubagentChip?.((active as Extract<SessionSurface, { kind: "chat" }>).id)}
            subagentView={resolveSubagentView((active as Extract<SessionSurface, { kind: "chat" }>).id)}
          />
          <Launcher api={api} />
          {api.onOpenCheckpoints ? <ConversationActions onOpen={api.onOpenCheckpoints} /> : null}
          {/* Hidden draggable elements for all chats to enable drag-to-split and programmatic close */}
          {chatTabs.map((chat) => (
            <div
              key={chat.id}
              data-testid={`editor-tab-chat-${chat.id}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(mime, JSON.stringify({ surface: chat, from: group.id } satisfies TabDrag))
                e.dataTransfer.effectAllowed = "copyMove"
              }}
              className="pointer-events-none absolute inset-0"
              aria-hidden
            >
            </div>
          ))}
          {tabStripDrop.overlay}
        </div>
      ) : (
      <div
        data-testid="editor-tab-strip"
        {...tabStripHandlers}
        className="relative flex h-10 flex-none items-stretch border-b border-hairline bg-sunken"
      >
        <div role="tablist" className="sb-no-scrollbar flex min-w-0 flex-1 items-stretch overflow-x-auto">
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
        {active.kind === "chat" && api.onOpenCheckpoints ? <ConversationActions onOpen={api.onOpenCheckpoints} /> : null}
        {tabStripDrop.overlay}
      </div>
      )}
      {!collapsed && crumbs.length > 0 && (
        <Breadcrumb crumbs={crumbs} className={active.kind === "file" ? "@container h-8" : undefined}>
          {active.kind === "file" ? (
            <>
              {renderAgentEdits(api.sessionId, active.id)}
              <span ref={setHeaderSlot} className="flex items-center gap-2" />
            </>
          ) : null}
        </Breadcrumb>
      )}
      {!collapsed && (
        <div className="relative flex min-h-0 min-w-0 flex-1">
          {group.tabs.map((surface) => {
            const key = sessionSurfaceKey(surface)
            return <TabBody key={key} surface={surface} visible={key === group.active} headerSlot={key === group.active ? headerSlot : null} focused={focused} api={api} revision={revision} />
          })}
        </div>
      )}
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
        if (surface.kind === "file") e.dataTransfer.setData(editorFileMime, "")
        e.dataTransfer.effectAllowed = "copyMove"
      }}
      onAuxClick={(e) => e.button === 1 && api.onClose(groupId, surface)}
      className={cn(
        "group flex flex-none items-center border-b-2 border-r border-r-hairline text-xs",
        selected
          ? cn("bg-editor text-text-bright", focused ? "border-b-text-bright" : "border-b-line-strong")
          : "border-b-transparent text-muted-foreground hover:text-text"
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
  headerSlot,
  focused,
  api,
  revision
}: {
  surface: SessionSurface
  visible: boolean
  headerSlot: HTMLElement | null
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
      <FileHeaderSlotContext.Provider value={headerSlot}>
        <TabContent
          surface={surface}
          focused={surface.kind === "file" ? false : focused && visible}
          visible={visible}
          api={api}
          revision={revision}
        />
      </FileHeaderSlotContext.Provider>
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

/** The group's + menu: the view launcher items. */
function Launcher({ api }: { api: Api }) {
  const items = api.launcherItems ?? []
  if (items.length === 0) return null
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="sm" aria-label="New tab" title="New chat or tab" className="h-auto flex-none rounded-none px-2">
          <Plus className="size-3.5" />
        </Button>
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

function ConversationActions({ onOpen }: { onOpen(trigger: HTMLButtonElement | null): void }) {
  const trigger = useRef<HTMLButtonElement>(null)
  const openingDialog = useRef(false)
  return <DropdownMenu.Root onOpenChange={(open) => { if (open) openingDialog.current = false }}>
    <DropdownMenu.Trigger asChild>
      <button ref={trigger} type="button" aria-label="More conversation actions" className="flex flex-none items-center px-2 text-dim outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-ring">
        <Ellipsis className="size-3.5" />
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content align="end" sideOffset={6} collisionPadding={8}
        onCloseAutoFocus={(event) => { if (openingDialog.current) event.preventDefault() }}
        className="z-50 rounded-lg border border-line bg-sunken p-1.5 shadow-2xl">
        <DropdownMenu.Item onSelect={() => { openingDialog.current = true; onOpen(trigger.current) }}
          className="cursor-pointer rounded-md px-2.5 py-2 text-[12.5px] text-text-body outline-none data-[highlighted]:bg-surface data-[highlighted]:text-text-bright">Checkpoints</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
}
