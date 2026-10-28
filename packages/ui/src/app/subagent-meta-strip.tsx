import type { ProviderId, SubagentFleetNode } from "@jingler/core"
import { ChevronDown } from "lucide-react"
import { useEffect, useState } from "react"
import { Badge, type BadgeTone } from "../components/badge.js"
import { Button } from "../components/button.js"
import { StatusDot } from "../components/status-dot.js"
import { DiffStat } from "../components/diff-stat.js"
import { ProviderIcon } from "../components/provider-icon.js"
import { cn } from "../lib/cn.js"

export const LIVE_STATUSES: ReadonlySet<SubagentFleetNode["status"]> = new Set(["queued", "running", "paused", "needs-attention"])

type FleetStatus = SubagentFleetNode["status"]

const STATUS_LABEL: Record<FleetStatus, string> = {
  queued: "Queued",
  running: "Running",
  paused: "Paused",
  "needs-attention": "Needs you",
  completed: "Done",
  failed: "Failed",
  stopped: "Stopped",
  unknown: "Unknown"
}

const STATUS_TONE: Record<FleetStatus, { badge: BadgeTone; dot: string }> = {
  queued: { badge: "neutral", dot: "bg-dim" },
  running: { badge: "blue", dot: "bg-blue" },
  paused: { badge: "yellow", dot: "bg-yellow" },
  "needs-attention": { badge: "yellow", dot: "bg-yellow" },
  completed: { badge: "green", dot: "bg-green" },
  failed: { badge: "red", dot: "bg-red" },
  stopped: { badge: "neutral", dot: "bg-dim" },
  unknown: { badge: "neutral", dot: "bg-dim" }
}

/** StatusDot props for a fleet status: live statuses pulse. */
export const fleetStatusDot = (status: FleetStatus) => ({
  tone: STATUS_TONE[status].dot,
  pulse: status === "running"
})

const compact = (n: number): string => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n))

export function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function IdentityRow({
  node,
  providerId,
  expanded,
  onToggle
}: {
  node: SubagentFleetNode
  providerId?: ProviderId
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <div data-testid="subagent-meta-identity" className="flex min-w-0 items-center gap-2">
      <ProviderIcon providerId={providerId} size={14} />
      <span className="min-w-0 truncate text-[13px] font-semibold text-text-bright">{node.agent}</span>
      <StatusDot {...fleetStatusDot(node.status)} size={7} />
      <Badge tone={STATUS_TONE[node.status].badge} size="xs">{STATUS_LABEL[node.status]}</Badge>
      {node.phase && <span className="min-w-0 truncate text-[11px] text-muted-foreground">{node.phase}</span>}
      <span className="flex-1" />
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={expanded}
        data-testid="subagent-meta-details-toggle"
        onClick={onToggle}
        className="h-5 flex-none gap-1 px-1.5 text-[11px]"
      >
        Details <ChevronDown className={cn("size-3", expanded && "rotate-180")} />
      </Button>
    </div>
  )
}

/** One wrapping mono line: model, branch (or shared checkout), diff, PR chip, tokens, Background. */
function FactsLine({ node, onOpenPullRequest }: { node: SubagentFleetNode; onOpenPullRequest?: (prNumber: number) => void }) {
  const { workspace, prNumber } = node
  const { inputTokens, outputTokens, toolCalls, costUsd } = node.usage
  const usage = [
    inputTokens + outputTokens > 0 ? `${compact(inputTokens)} in / ${compact(outputTokens)} out` : null,
    toolCalls > 0 ? `${toolCalls} ${toolCalls === 1 ? "tool call" : "tool calls"}` : null,
    costUsd > 0 ? `$${costUsd.toFixed(2)}` : null
  ].filter((part) => part !== null)
  return (
    <div data-testid="subagent-meta-facts" className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-text-body">
      {node.model && <span data-testid="subagent-meta-model">{node.model}</span>}
      <span data-testid="subagent-meta-workspace" className={workspace ? "break-all" : "text-dim"}>
        {workspace ? workspace.branch : "Shared checkout"}
      </span>
      {workspace?.diff && <DiffStat added={workspace.diff.added} removed={workspace.diff.removed} className="flex-none" />}
      {prNumber !== null && (
        <Button
          variant="outline"
          size="sm"
          data-testid="subagent-meta-pr"
          aria-label={`Open pull request #${prNumber}`}
          onClick={() => onOpenPullRequest?.(prNumber)}
          className="h-5 flex-none px-1.5 font-mono text-[10px]"
        >
          PR #{prNumber}
        </Button>
      )}
      {usage.length > 0 && <span data-testid="subagent-meta-usage" className="text-dim">{usage.join(" · ")}</span>}
      {node.background && <Badge tone="neutral" size="xs">Background</Badge>}
    </div>
  )
}

function ArtifactRow({ node, onOpenArtifact }: { node: SubagentFleetNode; onOpenArtifact?: (path: string) => void }) {
  if (node.artifacts.length === 0) return null
  return (
    <div data-testid="subagent-meta-artifacts" className="flex flex-wrap gap-1">
      {node.artifacts.map((artifact) => (
        <Button
          key={artifact.path}
          variant="outline"
          size="sm"
          onClick={() => onOpenArtifact?.(artifact.path)}
          className="h-5 flex-none px-1.5 text-[10px]"
        >
          {artifact.label || artifact.path.split("/").at(-1)}
        </Button>
      ))}
    </div>
  )
}

function DetailsGrid({ node }: { node: SubagentFleetNode }) {
  const entries: ReadonlyArray<readonly [string, string]> = [
    ["Run", node.runId],
    ["Started", new Date(node.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })]
  ]
  return (
    <dl data-testid="subagent-meta-details" className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
      {entries.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-dim">{label}</dt>
          <dd className="min-w-0 truncate font-mono text-text-body">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Identity, one facts line and a Details disclosure; rendered at the top of the subagent view's centred column. */
export function SubagentMetaStrip({
  node,
  providerId,
  onOpenArtifact,
  onOpenPullRequest
}: {
  node: SubagentFleetNode
  providerId?: ProviderId
  onOpenArtifact?: (path: string) => void
  /** Opens the PR view (6.18) for the child's PR. */
  onOpenPullRequest?: (prNumber: number) => void
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div data-testid="subagent-meta-strip" className="flex flex-col gap-1.5 text-[11px]">
      <IdentityRow node={node} providerId={providerId} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
      <FactsLine node={node} onOpenPullRequest={onOpenPullRequest} />
      <ArtifactRow node={node} onOpenArtifact={onOpenArtifact} />
      {expanded && <DetailsGrid node={node} />}
    </div>
  )
}
