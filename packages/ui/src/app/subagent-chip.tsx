import type { AgentRosterEntry, PeerAgentMessageResult } from "@jingler/core"
import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { ChevronDown } from "lucide-react"
import { useEffect, useState } from "react"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import { PeerAgentRow } from "./agent-roster.js"
import { StatusDot } from "../components/status-dot.js"

export type SubagentChipStatus =
  | "spawning"
  | "running"
  | "paused"
  | "attention"
  | "completed"
  | "failed"
  | "stopped"

export interface SubagentChipItem {
  readonly id: string
  readonly agent: string
  readonly task: string
  readonly status: SubagentChipStatus
  /** Epoch ms the child started. */
  readonly startedAt: number
  /** Epoch ms the child finished; elapsed freezes here. */
  readonly endedAt?: number
}

export interface SubagentChipProps {
  /** Every child of the active chat, live and finished. */
  readonly subagents: ReadonlyArray<SubagentChipItem>
  /** Open one child's transcript. */
  readonly onOpenSubagent: (id: string) => void
  /** Other chats in the session, listed under `Peers · N`. */
  readonly peers?: ReadonlyArray<AgentRosterEntry>
  /** Send a message to one peer chat. Required to show a `Message` button per peer. */
  readonly onMessagePeer?: (chatId: string, text: string) => Promise<PeerAgentMessageResult>
}

/** Rows shown per popover section before the rest collapse into `+N more`. */
const MAX_ROWS = 8

const FINISHED: ReadonlySet<SubagentChipStatus> = new Set(["completed", "failed", "stopped"])
const STATUS_WORD: Record<SubagentChipStatus, string> = {
  spawning: "spawning",
  running: "running",
  paused: "paused",
  attention: "needs you",
  completed: "done",
  failed: "failed",
  stopped: "stopped"
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function Row({ item, now, onOpen }: { item: SubagentChipItem; now: number; onOpen: (id: string) => void }) {
  const failed = item.status === "failed"
  return (
    <DropdownMenu.Item
      data-testid={`subagent-chip-row-${item.id}`}
      onSelect={() => onOpen(item.id)}
      className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-[12.5px] outline-none data-[highlighted]:bg-surface data-[highlighted]:text-text-bright"
    >
      <StatusDot
        tone={failed ? "bg-state-failed" : FINISHED.has(item.status) ? "bg-dim" : "bg-muted-foreground"}
        pulse={item.status === "spawning" || item.status === "running"}
        size={7}
      />
      <span className={failed ? "flex-none text-state-failed" : "flex-none text-dim"}>{STATUS_WORD[item.status]}</span>
      <span className="flex-none font-medium text-text-bright">{item.agent}</span>
      <span className="min-w-0 flex-1 truncate text-text-body">{item.task}</span>
      <span className="flex-none tabular-nums text-dim">{formatElapsed((item.endedAt ?? now) - item.startedAt)}</span>
    </DropdownMenu.Item>
  )
}

function Rows({ items, now, onOpen }: { items: ReadonlyArray<SubagentChipItem>; now: number; onOpen: (id: string) => void }) {
  return (
    <>
      {items.slice(0, MAX_ROWS).map((item) => (
        <Row key={item.id} item={item} now={now} onOpen={onOpen} />
      ))}
      {items.length > MAX_ROWS && (
        <div className="px-2.5 py-1">
          <Badge tone="count" size="xs">+{items.length - MAX_ROWS} more</Badge>
        </div>
      )}
    </>
  )
}

/**
 * Lane-header chip for the active chat's child agents: `N subagents ▾`, pulsing
 * while any child is spawning or running. Opens a popover of running children
 * then a `Finished · N` section, then `Peers · N`; a row opens that child's
 * transcript and a peer's `Message` sends it a note.
 */
export function SubagentChip({ subagents, onOpenSubagent, peers = [], onMessagePeer }: SubagentChipProps) {
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const running = subagents.filter((item) => !FINISHED.has(item.status))
  const finished = subagents.filter((item) => FINISHED.has(item.status))
  const pulsing = running.some((item) => item.status === "spawning" || item.status === "running")
  const ticking = open && running.length > 0

  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [ticking])

  if (subagents.length === 0 && peers.length === 0) return null
  const label =
    running.length > 0
      ? `${running.length} ${running.length === 1 ? "subagent" : "subagents"}`
      : finished.length > 0
        ? `${finished.length} finished`
        : `${peers.length} ${peers.length === 1 ? "peer" : "peers"}`

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-testid="subagent-chip"
          aria-label={`${label}, open list`}
          className="flex-none gap-1.5 px-2 text-xs"
        >
          <StatusDot tone="bg-muted-foreground" pulse={pulsing} size={7} />
          <span>{label}</span>
          <ChevronDown className="size-3 flex-none text-dim" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          data-testid="subagent-chip-popover"
          className="z-50 flex w-[360px] max-w-[calc(100vw-1rem)] flex-col gap-0.5 rounded-lg border border-line bg-sunken p-1.5 shadow-2xl"
        >
          <Rows items={running} now={now} onOpen={onOpenSubagent} />
          {finished.length > 0 && (
            <>
              <DropdownMenu.Label className="px-2.5 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-dim">
                Finished · {finished.length}
              </DropdownMenu.Label>
              <Rows items={finished} now={now} onOpen={onOpenSubagent} />
            </>
          )}
          {peers.length > 0 && onMessagePeer !== undefined && (
            <>
              <DropdownMenu.Label className="px-2.5 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-dim">
                Peers · {peers.length}
              </DropdownMenu.Label>
              {peers.map((agent) => (
                <PeerAgentRow key={agent.chatId} agent={agent} onMessage={onMessagePeer} />
              ))}
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
