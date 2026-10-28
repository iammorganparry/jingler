import type { PrTimelineItem } from "@jingler/core"
import { Check, MessageSquare, X } from "lucide-react"
import { relativeTime } from "../lib/relative-time.js"
import { Avatar, githubAvatarUrl } from "../components/avatar.js"
import { Card } from "../components/card.js"
import { ClaudeGlyph } from "../components/eyebrow.js"
import { CodeChip } from "../components/code-chip.js"
import { Markdown } from "../components/markdown.js"
import { AsyncButton } from "../components/async-button.js"

// Neutral icons for every kind (spec §6.3): the kind is carried by the icon shape and label, not colour.
const kindMeta = {
  commented: { Icon: MessageSquare, label: "commented" },
  approved: { Icon: Check, label: "approved" },
  changes_requested: { Icon: X, label: "requested changes" }
} as const

/**
 * A single review / comment entry in the PR timeline — a kind-coded left rail,
 * the author's review body, an optional inline code reference, and a "send to
 * agent" action that hands the feedback to the session's agent.
 */
export function PrTimelineEntry({
  item,
  sent = false,
  repository,
  onSendToAgent
}: {
  item: PrTimelineItem
  /** `owner/repo` that bare `#123` and SHAs link against. */
  repository?: string
  /** This entry has already been routed to the agent — the action stays "Sent". */
  sent?: boolean
  onSendToAgent?: (id: string) => Promise<void> | void
}) {
  const meta = kindMeta[item.kind]
  const hasRef = item.path !== null && item.line !== null

  return (
    <div className="flex items-start gap-[11px]">
      <span
        className="mt-0.5 flex size-[26px] flex-none items-center justify-center rounded-full bg-surface"
      >
        <meta.Icon size={13} className="text-muted-foreground" />
      </span>
      <Card className="flex-1">
        <div className="flex items-center gap-[9px] border-b border-hairline px-[14px] py-[11px]">
          <Avatar
            initial={item.author.charAt(0).toUpperCase()}
            src={githubAvatarUrl(item.author)}
            tone="orange"
            size={22}
          />
          <span className="text-[13px] font-medium text-text-bright">{item.author}</span>
          <span className="text-[12px] text-muted-foreground">{meta.label}</span>
          <div className="flex-1" />
          <span className="font-mono text-[11px] text-dim">{relativeTime(item.createdAt)}</span>
        </div>
        <div className="flex flex-col gap-[11px] px-[14px] py-[11px]">
          {item.body && <Markdown className="text-[13.5px]" repository={repository}>{item.body}</Markdown>}
          {hasRef && (
            <CodeChip path={item.path as string} line={item.line as number} className="self-start" />
          )}
          {onSendToAgent && (
            <div className="flex items-center gap-2">
              <AsyncButton
                variant="secondary"
                icon={<ClaudeGlyph />}
                pendingLabel="Sending…"
                successLabel="Sent"
                doneLabel="Sent to agent"
                terminal
                done={sent}
                onClick={() => onSendToAgent(item.id)}
              >
                Send to agent
              </AsyncButton>
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
