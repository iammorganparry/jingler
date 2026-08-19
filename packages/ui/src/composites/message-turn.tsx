import { memo, type ReactNode, useState } from "react"
import { planTaskProtocolTokens, stripPlanResultProtocol } from "@jingler/core"
import type { ContentPart, ExecutionMode, GateDecision, Message, ProviderId, ToolCall as ToolCallModel } from "@jingler/core"
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, LoaderCircle } from "lucide-react"
import { cn } from "../lib/cn.js"
import { AttachmentThumb } from "../components/attachment-thumb.js"
import { Eyebrow } from "../components/eyebrow.js"
import { DiffPeek } from "../components/diff-peek.js"
import { FileChangeList } from "../components/file-change-list.js"
import { Markdown } from "../components/markdown.js"
import { providerColor, providerLabel, ProviderIcon } from "../components/provider-icon.js"
import { ApprovalGate } from "./approval-gate.js"
import { BranchDriftBanner } from "./branch-drift-banner.js"
import { ContextDivider } from "./context-divider.js"
import { PlanCard } from "./plan-card.js"
import { QuestionSummary } from "./question-summary.js"
import { ThoughtBlock } from "./thought-block.js"
import { ToolCall } from "./tool-call.js"
import { toolDisplayName } from "../lib/tool-names.js"

// Parts fill the transcript's centered content column (width is owned by
// ConversationView), so nothing here caps its own width.
const WIDTH = "w-full"

/** A run of this many consecutive tool calls (no text between) collapses to the latest. */
const COLLAPSE_MIN = 3

type ToolPart = Extract<ContentPart, { _tag: "Tool" }>
type ImagePart = Extract<ContentPart, { _tag: "Image" }>
type ThinkingPart = Extract<ContentPart, { _tag: "Thinking" }>
type PlanTaskProgressPart = Extract<ContentPart, { _tag: "PlanTaskProgress" }>

/** An attached image on a user turn — a read-only transcript thumbnail. */
const IMAGE_THUMB = "h-[80px] w-[132px]"

const toolMeta = (tool: ToolCallModel): string | undefined => {
  if (tool.meta !== null) return tool.meta
  // A run that touched nothing has no change story to tell — "0 files · +0 −0"
  // on every Bash call is noise, not information.
  if (tool.fileChanges !== undefined && tool.fileChanges.changes.length > 0) {
    const count = tool.fileChanges.changes.length
    const { added, removed } = tool.fileChanges.totals
    return `${count} ${count === 1 ? "file" : "files"} · +${added} −${removed}`
  }
  return tool.diff && tool.diff.added + tool.diff.removed > 0
    ? `+${tool.diff.added} −${tool.diff.removed}`
    : undefined
}

/**
 * Tools whose `target` is a file path, and so get a file glyph and the
 * filename-preserving layout. Everything else targets a query or a command
 * (Bash, Grep, Glob), where the useful part is the START of the string and a
 * file icon would be a lie.
 */
const PATH_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Write",
  "Edit",
  "Update",
  "MultiEdit",
  "NotebookEdit",
  "Delete",
  "Rename"
])

const pathOf = (tool: ToolCallModel, displayName: string): string | null => {
  const changes = tool.fileChanges?.changes
  if (changes?.length === 1) return changes[0]!.path
  return tool.target && PATH_TOOLS.has(displayName) ? tool.target : null
}

/** Lines of a diff hunk shown before the "Show all" affordance kicks in. */
const HUNK_PREVIEW_LINES = 12

const TASK_PROGRESS_META = {
  "in-progress": { label: "In progress", Icon: LoaderCircle, tone: "text-blue border-blue/30 bg-blue/10" },
  completed: { label: "Completed", Icon: CheckCircle2, tone: "text-green border-green/30 bg-green/10" },
  blocked: { label: "Blocked", Icon: AlertCircle, tone: "text-yellow border-yellow/30 bg-yellow/10" }
} as const

function PlanTaskProgressChip({ progress }: { progress: Omit<PlanTaskProgressPart, "_tag"> }) {
  const meta = TASK_PROGRESS_META[progress.status]
  const { Icon } = meta
  return (
    <span
      data-plan-task-progress={progress.taskId}
      aria-label={`${progress.taskId}: ${meta.label}`}
      className={cn(
        "inline-flex w-fit items-center gap-1.5 rounded-full border px-2 py-1 font-mono text-[10.5px]",
        meta.tone
      )}
    >
      <Icon className={cn("size-3", progress.status === "in-progress" && "animate-spin")} />
      <span>{progress.taskId}</span>
      <span className="font-sans font-medium">{meta.label}</span>
    </span>
  )
}

function ProtocolText({ text, markdown }: { text: string; markdown: boolean }) {
  const tokens = planTaskProtocolTokens(markdown ? stripPlanResultProtocol(text) : text)
  const hasProgress = tokens.some((token) => token.kind === "progress")
  if (!hasProgress) {
    const visible = tokens.map((token) => token.kind === "text" ? token.text : "").join("")
    if (visible.length === 0) return null
    return markdown ? (
      <Markdown className={WIDTH}>{visible}</Markdown>
    ) : (
      <p className={`m-0 ${WIDTH} whitespace-pre-wrap text-[calc(14.5px*var(--sb-font-scale,1))] leading-[1.65] text-text-body`}>
        {visible}
      </p>
    )
  }
  return (
    <div className={cn(WIDTH, "flex flex-col gap-2")}>
      {tokens.map((token, index) =>
        token.kind === "progress" ? (
          <PlanTaskProgressChip key={`progress-${index}`} progress={token.progress} />
        ) : token.text.trim().length > 0 ? (
          markdown ? (
            <Markdown key={`text-${index}`} className={WIDTH}>{token.text}</Markdown>
          ) : (
            <p key={`text-${index}`} className="m-0 whitespace-pre-wrap text-[calc(14.5px*var(--sb-font-scale,1))] leading-[1.65] text-text-body">
              {token.text}
            </p>
          )
        ) : null
      )}
    </div>
  )
}

function ToolCardView({ tool }: { tool: ToolCallModel }) {
  const [expanded, setExpanded] = useState(false)
  const canonicalChanges = tool.fileChanges?.changes ?? []
  const legacyPreview = canonicalChanges.length === 0 ? tool.preview : null
  const lines = legacyPreview ? legacyPreview.replace(/\n+$/, "").split("\n") : []
  const clipped = lines.length > HUNK_PREVIEW_LINES && !expanded
  const shown = clipped ? lines.slice(0, HUNK_PREVIEW_LINES).join("\n") : legacyPreview
  // An edit's change is already spelled out by its diff peek, so its header stays
  // inert and the existing "Show all N lines" control owns that body. Everything
  // else — a command and what it printed — only fits once opened.
  const openable = canonicalChanges.length === 0 && !legacyPreview &&
    (tool.output !== undefined || (tool.target?.length ?? 0) > 0)
  const displayName = toolDisplayName(tool.name)
  const path = pathOf(tool, displayName)
  return (
    <ToolCall
      status={tool.status}
      name={displayName}
      target={tool.target ?? undefined}
      filePath={path}
      meta={toolMeta(tool)}
      expanded={expanded}
      onToggle={openable ? () => setExpanded((v) => !v) : undefined}
      className={WIDTH}
    >
      {canonicalChanges.length > 0 && <FileChangeList changes={canonicalChanges} />}
      {openable && expanded && (
        <div className="border-t border-line bg-editor">
          {/* The header truncates a long command to one line; this is where you
              read the whole thing. */}
          {tool.target && (
            <pre className="overflow-x-auto px-3 py-2 font-mono text-[calc(11px*var(--sb-font-scale,1))] leading-[1.5] text-text-bright">
              {tool.target}
            </pre>
          )}
          {tool.output === undefined ? (
            <div className="px-3 pb-2 font-mono text-[calc(11px*var(--sb-font-scale,1))] text-dim">
              {tool.status === "running" ? "Running…" : "No output."}
            </div>
          ) : (
            <pre className="max-h-[320px] overflow-auto border-t border-line/60 px-3 py-2 font-mono text-[calc(11px*var(--sb-font-scale,1))] leading-[1.5] text-muted-foreground">
              {tool.output}
            </pre>
          )}
        </div>
      )}
      {legacyPreview && shown && (
        <div>
          <DiffPeek preview={shown} />
          {lines.length > HUNK_PREVIEW_LINES && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="flex w-full items-center gap-1 bg-editor px-3 py-1 text-[11px] text-line-strong transition-colors hover:text-muted-foreground active:scale-[0.99]"
            >
              {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              {expanded ? "Hide" : `Show all ${lines.length} lines`}
            </button>
          )}
        </div>
      )}
    </ToolCall>
  )
}

/**
 * A run of consecutive tool calls, collapsed to the latest one with a "+ N more"
 * toggle above it — so a storm of Reads/greps doesn't drown the conversation.
 */
function ToolGroup({ tools }: { tools: ReadonlyArray<ToolCallModel> }) {
  const [expanded, setExpanded] = useState(false)
  const hidden = tools.length - 1
  return (
    <div className={cn("flex flex-col gap-3", WIDTH)}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 self-start rounded-md border border-line px-2.5 py-1 font-mono text-[10.5px] text-muted-foreground transition-colors hover:bg-surface hover:text-text active:scale-[0.98]"
      >
        {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        {expanded
          ? `Hide ${hidden} earlier ${hidden === 1 ? "call" : "calls"}`
          : `+ ${hidden} more tool ${hidden === 1 ? "call" : "calls"}`}
      </button>
      {expanded ? (
        tools.map((tool, i) => <ToolCardView key={i} tool={tool} />)
      ) : (
        <ToolCardView tool={tools[tools.length - 1]!} />
      )}
    </div>
  )
}

/**
 * One or more consecutive reasoning parts compiled into a single thought pill.
 * Chained provider reasoning (summary bursts with nothing between them) reads
 * as one thought, so it renders as one: durations sum, and the body joins the
 * texts in order.
 */
function MergedThoughts({ parts }: { parts: ReadonlyArray<ThinkingPart> }) {
  const known = parts
    .map((part) => part.seconds)
    .filter((seconds): seconds is number => seconds !== null)
  const seconds = known.length > 0 ? known.reduce((a, b) => a + b, 0) : null
  const streaming = parts.some((part) => part.streaming)
  const text = parts
    .map((part) => part.text.trim())
    .filter((chunk) => chunk.length > 0)
    .join("\n\n")
  return (
    <ThoughtBlock seconds={seconds} streaming={streaming} className={WIDTH}>
      {text.length > 0 ? (
        <Markdown className="text-[calc(11px*var(--sb-font-scale,1))] leading-[1.6] text-dim">
          {text}
        </Markdown>
      ) : null}
    </ThoughtBlock>
  )
}

function PartView({
  part,
  markdown,
  onDecideGate,
  onApprovePlan,
  onResumePlan,
  onOpenPlanReview,
  onForkOntoBranch,
  onAdoptBranch
}: {
  part: ContentPart
  markdown: boolean
  onDecideGate?: (gateId: string, decision: GateDecision) => void
  onApprovePlan?: (planId: string, executionMode?: ExecutionMode) => void
  onResumePlan?: (planId: string) => void
  onOpenPlanReview?: () => void
  onForkOntoBranch?: () => void | Promise<void>
  onAdoptBranch?: () => void | Promise<void>
}) {
  switch (part._tag) {
    case "Text": {
      return <ProtocolText text={part.text} markdown={markdown} />
    }
    case "PlanTaskProgress":
      return <PlanTaskProgressChip progress={part} />
    case "Image":
      // Images are normally grouped into a row (see renderParts); this covers a
      // lone image part rendered directly.
      return <AttachmentThumb attachment={part.attachment} className={IMAGE_THUMB} />
    case "Thinking":
      return <MergedThoughts parts={[part]} />

    case "Tool":
      return <ToolCardView tool={part.tool} />
    case "Gate":
      return (
        <ApprovalGate
          kind={part.gate.kind}
          title={part.gate.title}
          detail={part.gate.detail}
          command={part.gate.command}
          allowLabel={part.gate.allowLabel}
          status={part.gate.status}
          onDecide={(decision) => onDecideGate?.(part.gate.id, decision)}
          className={WIDTH}
        />
      )
    case "Question":
      // Pending questions dock in the composer (as the QuestionCard); once
      // answered, show a compact record of the picks here so the choice persists.
      return part.answers === null ? null : (
        <QuestionSummary request={part.request} answers={part.answers} className={WIDTH} />
      )
    case "Plan":
      return (
        <PlanCard
          plan={part.plan}
          onApprove={
            onApprovePlan === undefined
              ? undefined
              : (executionMode) => onApprovePlan(part.plan.id, executionMode)
          }
          onResume={
            onResumePlan === undefined
              ? undefined
              : () => onResumePlan(part.plan.id)
          }
          onOpenReview={onOpenPlanReview}
        />
      )
    case "Context":
      // Deliberately full-width and unindented: this marks a boundary in the
      // conversation rather than being something the agent said.
      return <ContextDivider digest={part.digest} tokensBefore={part.tokensBefore} />
    case "BranchDrift":
      return (
        <BranchDriftBanner
          pinnedBranch={part.pinnedBranch}
          liveBranch={part.liveBranch}
          onFork={onForkOntoBranch}
          onAdopt={onAdoptBranch}
          className={WIDTH}
        />
      )
  }
}

/**
 * Render a turn's parts, collapsing runs of ≥ `COLLAPSE_MIN` consecutive tool
 * calls (with no text between) into a single `ToolGroup`. Anything else renders
 * in program order.
 */
function renderParts(
  parts: ReadonlyArray<ContentPart>,
  markdown: boolean,
  handlers: {
    onDecideGate?: (gateId: string, decision: GateDecision) => void
    onApprovePlan?: (planId: string, executionMode?: ExecutionMode) => void
    onResumePlan?: (planId: string) => void
    onOpenPlanReview?: () => void
    onForkOntoBranch?: () => void | Promise<void>
    onAdoptBranch?: () => void | Promise<void>
  },
  // When a mega-turn's prefix is collapsed, `parts` is a suffix of the real
  // array — keys must stay ABSOLUTE so expanding doesn't remount the tail.
  keyOffset = 0
): ReactNode[] {
  const out: ReactNode[] = []
  let run: ToolPart[] = []
  let runStart = 0
  const flush = () => {
    if (run.length === 0) return
    if (run.length >= COLLAPSE_MIN) {
      out.push(<ToolGroup key={`g${runStart}`} tools={run.map((p) => p.tool)} />)
    } else {
      run.forEach((p, k) => {
        out.push(<ToolCardView key={`${runStart}-${k}`} tool={p.tool} />)
      })
    }
    run = []
  }
  // Consecutive attached images render as a single wrapping thumbnail row.
  let imgs: ImagePart[] = []
  let imgStart = 0
  const flushImgs = () => {
    if (imgs.length === 0) return
    out.push(
      <div key={`i${imgStart}`} className={cn("flex flex-wrap gap-2", WIDTH)}>
        {imgs.map((p, k) => (
          <AttachmentThumb key={`${imgStart}-${k}`} attachment={p.attachment} className={IMAGE_THUMB} />
        ))}
      </div>
    )
    imgs = []
  }
  // Chained reasoning (consecutive Thinking parts) compiles into one thought.
  let thoughts: ThinkingPart[] = []
  let thoughtStart = 0
  const flushThoughts = () => {
    if (thoughts.length === 0) return
    out.push(<MergedThoughts key={`t${thoughtStart}`} parts={thoughts} />)
    thoughts = []
  }
  parts.forEach((part, localIndex) => {
    const i = localIndex + keyOffset
    if (part._tag === "Tool") {
      flushImgs()
      flushThoughts()
      if (run.length === 0) runStart = i
      run.push(part)
      return
    }
    if (part._tag === "Image") {
      flush()
      flushThoughts()
      if (imgs.length === 0) imgStart = i
      imgs.push(part)
      return
    }
    if (part._tag === "Thinking") {
      flush()
      flushImgs()
      if (thoughts.length === 0) thoughtStart = i
      thoughts.push(part)
      return
    }
    flush()
    flushImgs()
    flushThoughts()
    out.push(<PartView key={i} part={part} markdown={markdown} {...handlers} />)
  })
  flush()
  flushImgs()
  flushThoughts()
  return out
}

/**
 * A turn with more parts than this renders only its tail until asked for the
 * rest. Agentic mega-turns are real: benchmarking the app against a live
 * transcript found single assistant messages with 512 and 669 parts (5.4MB of
 * JSON), and rendering one mounted tens of thousands of DOM nodes in a single
 * 3.4s main-thread task — the transcript is virtualized per TURN, so nothing
 * above this component can split the row up.
 */
const MEGA_TURN_MIN_PARTS = 160
/** How much of a collapsed mega-turn stays visible (the newest steps + reply). */
const MEGA_TURN_TAIL = 80

/**
 * The hidden-prefix boundary, quantized so it only moves once another
 * `MEGA_TURN_TAIL` parts accumulate — a live mega-turn appends parts while it
 * streams, and a boundary that tracked `length` exactly would shift every
 * render and re-key (remount) the whole visible tail each time.
 */
const hiddenPrefixLength = (partCount: number): number =>
  partCount > MEGA_TURN_MIN_PARTS
    ? Math.floor((partCount - MEGA_TURN_TAIL) / MEGA_TURN_TAIL) * MEGA_TURN_TAIL
    : 0

/**
 * One transcript turn: a You / provider eyebrow followed by its ordered parts.
 *
 * Memoised (see the export below): streaming replaces only the LAST message
 * object per token, so every settled turn keeps its `message` identity and can
 * skip re-rendering — without this, each token re-rendered every visible turn's
 * markdown and tool cards. The handler props must stay referentially stable for
 * that to hold; `useConversation` memoises them per actor for exactly this.
 */
function MessageTurnImpl({
  message,
  providerId,
  onDecideGate,
  onApprovePlan,
  onResumePlan,
  onOpenPlanReview,
  onForkOntoBranch,
  onAdoptBranch
}: {
  message: Message
  /** Canonical provider identity for the assistant eyebrow. */
  providerId?: ProviderId | null
  onDecideGate?: (gateId: string, decision: GateDecision) => void
  /** Approve a proposed plan inline (from the transcript's plan card). */
  onApprovePlan?: (planId: string, executionMode?: ExecutionMode) => void
  /** Approve a stale plan inline (re-drives execution after a restart). */
  onResumePlan?: (planId: string) => void
  /** Open the full Plan Review view from the inline plan card. */
  onOpenPlanReview?: () => void
  /** Fork a drifted direct session's work onto a new worktree session. */
  onForkOntoBranch?: () => void | Promise<void>
  /** Adopt the drifted checkout's branch into this session. */
  onAdoptBranch?: () => void | Promise<void>
}) {
  const isAssistant = message.role === "assistant"
  const [showAllParts, setShowAllParts] = useState(false)
  const hiddenParts = showAllParts ? 0 : hiddenPrefixLength(message.parts.length)
  const visibleParts =
    hiddenParts > 0 ? message.parts.slice(hiddenParts) : message.parts
  return (
    <div className="flex flex-col gap-3">
      {isAssistant ? (
        // Provider-branded eyebrow: logo + name in the provider's brand colour.
        <Eyebrow
          icon={<ProviderIcon providerId={providerId ?? undefined} mono />}
          style={{ color: providerColor(providerId) }}
        >
          {providerLabel(providerId)}
        </Eyebrow>
      ) : (
        <Eyebrow>You</Eyebrow>
      )}
      {hiddenParts > 0 && (
        <button
          type="button"
          data-testid="show-earlier-steps"
          onClick={() => setShowAllParts(true)}
          className="flex w-fit items-center gap-1.5 rounded-full border border-line bg-sunken px-3 py-1 text-[12px] text-muted-foreground outline-none transition-colors hover:text-foreground"
        >
          Show {hiddenParts} earlier steps
        </button>
      )}
      {renderParts(
        visibleParts,
        isAssistant,
        {
          onDecideGate,
          onApprovePlan,
          onResumePlan,
          onOpenPlanReview,
          onForkOntoBranch,
          onAdoptBranch
        },
        hiddenParts
      )}
    </div>
  )
}

export const MessageTurn = memo(MessageTurnImpl)
