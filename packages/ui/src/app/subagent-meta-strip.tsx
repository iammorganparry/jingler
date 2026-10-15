import type { ProviderId, SubagentFleetNode } from "@jingler/core"
import { ChevronDown } from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import { DiffStat } from "../components/diff-stat.js"
import { ProviderIcon } from "../components/provider-icon.js"
import { cn } from "../lib/cn.js"
import { fmtElapsed } from "../lib/relative-time.js"

const LIVE: ReadonlySet<SubagentFleetNode["status"]> = new Set(["queued", "running", "paused", "needs-attention"])

const compact = (n: number): string => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n))

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/** One strip row: children never shrink, `Grow` text takes the slack and truncates. */
const Row = ({ testId, children }: { testId: string; children: ReactNode }) => (
  <div data-testid={testId} className="flex min-w-0 items-center gap-2 whitespace-nowrap">
    {children}
  </div>
)
const Fixed = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span className={cn("flex-none", className)}>{children}</span>
)
const Grow = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span className={cn("min-w-0 flex-1 truncate", className)}>{children}</span>
)

function IdentityRow({
  node,
  providerId,
  now,
  expanded,
  onToggle
}: {
  node: SubagentFleetNode
  providerId?: ProviderId
  now: number
  expanded: boolean
  onToggle: () => void
}) {
  const status = node.phase ? `${node.status} · ${node.phase}` : node.status
  return (
    <Row testId="subagent-meta-identity">
      <ProviderIcon providerId={providerId} size={12} />
      {node.model && <Grow className="text-text-body">{node.model}</Grow>}
      {!node.model && <span className="flex-1" />}
      <Fixed className={node.status === "failed" ? "text-state-failed" : "text-muted-foreground"}>{status}</Fixed>
      <Fixed className="tabular-nums text-dim">{fmtElapsed((node.completedAt ?? now) - node.startedAt)}</Fixed>
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
    </Row>
  )
}

function UsageRow({ node }: { node: SubagentFleetNode }) {
  const { inputTokens, outputTokens, toolCalls, costUsd } = node.usage
  const usage = [
    inputTokens + outputTokens > 0 ? `${compact(inputTokens)} in / ${compact(outputTokens)} out` : null,
    toolCalls > 0 ? `${toolCalls} ${toolCalls === 1 ? "tool call" : "tool calls"}` : null,
    costUsd > 0 ? `$${costUsd.toFixed(2)}` : null
  ].filter((part) => part !== null)
  if (!node.currentTool && usage.length === 0 && !node.background) return null
  return (
    <Row testId="subagent-meta-usage">
      <Grow className="font-mono text-text-body">{node.currentTool}</Grow>
      {usage.length > 0 && <Fixed className="text-dim">{usage.join(" · ")}</Fixed>}
      {node.background && <Badge tone="neutral" size="xs">Background</Badge>}
    </Row>
  )
}

/** Worktree branch (mono, truncates first), diff stat and a PR chip that opens the PR view. Shared-checkout children say so. */
function WorkspaceRow({ node, onOpenPullRequest }: { node: SubagentFleetNode; onOpenPullRequest?: (prNumber: number) => void }) {
  const { workspace, prNumber } = node
  if (workspace === null && prNumber === null) return null
  return (
    <Row testId="subagent-meta-workspace">
      {workspace ? (
        <Grow className="font-mono text-text-body">{workspace.branch}</Grow>
      ) : (
        <Grow className="text-dim">Shared checkout</Grow>
      )}
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
    </Row>
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

/** Meta strip under the subagent breadcrumb (board 20a): up to 4 rows, `Details` opens a key/value grid. Null fields are omitted. */
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
  const now = useNow(LIVE.has(node.status) && node.completedAt === null)
  return (
    <div data-testid="subagent-meta-strip" className="flex flex-col gap-1.5 border-b border-line px-[30px] py-2 text-[11px]">
      <IdentityRow node={node} providerId={providerId} now={now} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
      <UsageRow node={node} />
      <WorkspaceRow node={node} onOpenPullRequest={onOpenPullRequest} />
      <ArtifactRow node={node} onOpenArtifact={onOpenArtifact} />
      {expanded && <DetailsGrid node={node} />}
    </div>
  )
}
