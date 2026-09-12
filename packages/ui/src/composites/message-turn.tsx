import { Spin } from "../components/spin.js"
import { createContext, memo, type ReactNode, useContext, useState } from "react"
import type { ContentPart, GateDecision, Message, PlanDocument, ProviderId, ToolCall as ToolCallModel } from "@jingler/core"
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  LoaderCircle,
  PauseCircle,
  XCircle
} from "lucide-react"
import { cn } from "../lib/cn.js"
import { AttachmentThumb } from "../components/attachment-thumb.js"
import { Eyebrow } from "../components/eyebrow.js"
import { DiffPeek } from "../components/diff-peek.js"
import { FileChangeList } from "../components/file-change-list.js"
import { Markdown } from "../components/markdown.js"
import { ToolResult as BeUIToolResult, ToolResultOutput } from "../components/beui/tool-result.js"
import { providerColor, providerLabel, ProviderIcon } from "../components/provider-icon.js"
import { ApprovalGate } from "./approval-gate.js"
import { BranchDriftBanner } from "./branch-drift-banner.js"
import { ContextDivider } from "./context-divider.js"
import { QuestionSummary } from "./question-summary.js"
import { ThoughtBlock } from "./thought-block.js"
import { ToolCall } from "./tool-call.js"
import { StreamingText } from "./streaming-text.js"
import { toolDisplayName } from "../lib/tool-names.js"

// Parts fill the transcript's centered content column (width is owned by
// ConversationView), so nothing here caps its own width.
const WIDTH = "w-full"

/** A run of this many consecutive tool calls (no text between) collapses to the latest. */
const COLLAPSE_MIN = 3

type ToolPart = Extract<ContentPart, { _tag: "Tool" }>

/**
 * Tool parts that may collapse into a "+ N more" run.
 */
const isGroupableTool = (part: ContentPart): part is ToolPart =>
  part._tag === "Tool"
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
  blocked: { label: "Blocked", Icon: AlertCircle, tone: "text-yellow border-yellow/30 bg-yellow/10" },
  skipped: { label: "Skipped", Icon: Circle, tone: "text-dim border-line bg-sunken" },
  failed: { label: "Failed", Icon: XCircle, tone: "text-red border-red/30 bg-red/10" },
  interrupted: { label: "Interrupted", Icon: PauseCircle, tone: "text-orange border-orange/30 bg-orange/10" }
} as const

function PlanTaskProgressChip({ progress }: { progress: Omit<PlanTaskProgressPart, "_tag"> }) {
  const meta = TASK_PROGRESS_META[progress.status]
  const { Icon } = meta
  const step = /(?:task|step)-(\d+)(?:-done)?$/.exec(progress.taskId)?.[1]
  const label = step ? `Step ${step}` : progress.taskId
  return (
    <span
      data-plan-task-progress={progress.taskId}
      aria-label={`${label}: ${meta.label}`}
      className={cn(
        "inline-flex w-fit items-center gap-1.5 rounded-full border px-2 py-1 font-mono text-[10.5px]",
        meta.tone
      )}
    >
      <Spin active={progress.status === "in-progress"}><Icon className="size-3" /></Spin>
      <span>{label}</span>
      <span className="font-sans font-medium">{meta.label}</span>
    </span>
  )
}

export const PlanProgressContext = createContext<PlanDocument | null>(null)

const MARKER_STATUS = {
  ACTIVE: "in-progress",
  DONE: "completed",
  BLOCKED: "blocked",
  SKIPPED: "skipped",
  FAILED: "failed",
  INTERRUPTED: "interrupted"
} as const

const progressTarget = (
  document: PlanDocument,
  step: number
): { readonly stageId: string; readonly taskId: string } | null => {
  for (const stage of document.plan.stages) {
    const taskId = `plannotator-task-${step}`
    if (stage.tasks?.some((task) => task.id === taskId)) return { stageId: stage.id, taskId }
    const acceptanceId = `plannotator-acceptance-${step}`
    if (stage.acceptance.some((criterion) => criterion.id === acceptanceId)) {
      return { stageId: stage.id, taskId: acceptanceId }
    }
    if (stage.id === `plannotator-step-${step}`) {
      return { stageId: stage.id, taskId: `${stage.id}-done` }
    }
  }
  return null
}

function renderProgressMarkers(text: string, planDocument: PlanDocument | null): ReactNode {
    const rendered: ReactNode[] = []
    const seen = new Set<string>()
    let cursor = 0
    for (const match of text.matchAll(/\[(ACTIVE|DONE|BLOCKED|SKIPPED|FAILED|INTERRUPTED):(\d+)\]/g)) {
      const index = match.index ?? 0
      const step = Number(match[2])
      const target = planDocument
        ? progressTarget(planDocument, step)
        : { stageId: `plannotator-step-${step}`, taskId: `plannotator-task-${step}` }
      if (!target) continue
      const prose = text.slice(cursor, index).replace(/[ \t]+$/, "")
      if (prose.length > 0) {
        rendered.push(<StreamingText key={`text-${index}`} text={prose} className={WIDTH} />)
      }
      const status = MARKER_STATUS[match[1] as keyof typeof MARKER_STATUS]
      const key = `${target.taskId}:${status}`
      if (!seen.has(key)) {
        seen.add(key)
        rendered.push(
          <PlanTaskProgressChip
            key={`progress-${key}`}
            progress={{ ...target, status }}
          />
        )
      }
      cursor = index + match[0].length
    }
    if (cursor > 0) {
      const prose = text.slice(cursor).replace(/^[ \t]+/, "")
      if (prose.length > 0) rendered.push(<StreamingText key="text-tail" text={prose} className={WIDTH} />)
      return <div className={cn("flex flex-col items-start gap-2", WIDTH)}>{rendered}</div>
    }
  return null
}

function MessageText({
  text,
  markdown,
  streaming = false
}: {
  text: string
  markdown: boolean
  streaming?: boolean
}) {
  const planDocument = useContext(PlanProgressContext)
  if (text.length === 0) return null
  if (markdown && !streaming) {
    const progress = renderProgressMarkers(text, planDocument)
    if (progress !== null) return progress
  }
  return markdown ? (
    <StreamingText text={text} streaming={streaming} className={WIDTH} />
  ) : (
    <p className={`m-0 ${WIDTH} whitespace-pre-wrap text-[calc(14.5px*var(--sb-font-scale,1))] leading-[1.65] text-text-body`}>
      {text}
    </p>
  )
}

/**
 * Interrupt the currently-running tool. Provided by the transcript host
 * (ConversationView) so a running Bash card can carry a stop button without
 * threading the callback through every nested renderer (ToolGroup, PartView).
 */
export const ToolStopContext = createContext<(() => void) | null>(null)

/** Command tools that can hang for minutes and so earn an inline stop button. */
const isStoppableTool = (displayName: string): boolean =>
  /^(bash|shell|terminal|command)/i.test(displayName)

/**
 * What an opened card with nothing to print says. A compacted card HAD output;
 * claiming "No output." would be a lie about the tool rather than about what
 * we kept.
 */
const emptyBodyNote = (tool: ToolCallModel): string => {
  if (tool.status === "running") return "Running…"
  return tool.compacted === true
    ? "Output released from memory — the full record is in the session transcript."
    : "No output."
}

/**
 * Memoised (like every part renderer below): the streaming turn's whole part
 * list re-renders on EVERY token, and `applyStreamEvent` replaces only the part
 * an event addresses — settled parts keep their object identity across folds.
 * Memo therefore skips every settled card per token; only the live tail (the
 * streaming Text/Thinking part, a running tool absorbing deltas) re-renders.
 * Without this, a visible mega-turn tail re-ran up to 80 markdown pipelines and
 * tool cards per token — the dominant renderer allocation churn while an agent
 * streams. Handler props are stable per actor (useConversation memoises them),
 * which this depends on.
 */
const ToolCardView = memo(function ToolCardView({ tool }: { tool: ToolCallModel }) {
                            function renderToolResult() {
                              return (<ToolCall
      status={tool.status}
      name={displayName}
      target={tool.target ?? undefined}
      filePath={path}
      meta={toolMeta(tool)}
      expanded={expanded}
      onToggle={openable ? () => setExpanded((v) => !v) : undefined}
      onStop={onStop}
      className={WIDTH}
    >
      {canonicalChanges.length > 0 && (
        <FileChangeList
          changes={canonicalChanges}
          initialLimit={tool.id.startsWith("reconcile:") ? 10 : undefined}
        />
      )}
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
              {emptyBodyNote(tool)}
            </div>
          ) : (
            <pre className="max-h-[320px] overflow-auto border-t border-line/60 px-3 py-2 font-mono text-[calc(11px*var(--sb-font-scale,1))] leading-[1.5] text-muted-foreground">
              {tool.output}
            </pre>
          )}
        </div>
      )}
      {renderLegacyPreview()}
    </ToolCall>)
                            }

                            function renderLegacyPreview() {
                              return (legacyPreview && shown && (
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
      ))
                            }

  const stopTool = useContext(ToolStopContext)
  const [expanded, setExpanded] = useState(tool.status === "running")
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
  const onStop =
    tool.status === "running" && stopTool !== null && isStoppableTool(displayName)
      ? stopTool
      : undefined
  if (isStoppableTool(displayName) && canonicalChanges.length === 0 && !legacyPreview) {
    const output = tool.output ?? emptyBodyNote(tool)
    return (
      <BeUIToolResult
        tool={displayName}
        title={tool.target ?? displayName}
        meta={toolMeta(tool)}
        status={tool.status}
        kind="terminal"
        open={expanded}
        onOpenChange={setExpanded}
        collapseOnComplete={false}
        maxHeight={320}
        copyText={tool.output}
        onStop={onStop}
        className={WIDTH}
      >
        <ToolResultOutput language="bash">{output}</ToolResultOutput>
      </BeUIToolResult>
    )
  }
  return (
    renderToolResult()
  )
})

/** Element-wise identity: the grouping arrays are rebuilt every render, but
 * their MEMBERS only change identity when an event actually touches them. */
const sameMembers = <T,>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): boolean =>
  a.length === b.length && a.every((item, i) => item === b[i])

/**
 * A run of consecutive tool calls, collapsed to the latest one with a "+ N more"
 * toggle above it — so a storm of Reads/greps doesn't drown the conversation.
 *
 * Memoised on the tools' identities, not the array's: renderParts rebuilds the
 * array each render (see sameMembers).
 */
const ToolGroup = memo(function ToolGroup({ tools }: { tools: ReadonlyArray<ToolCallModel> }) {
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
}, (prev, next) => sameMembers(prev.tools, next.tools))

/**
 * One or more consecutive reasoning parts compiled into a single thought pill.
 * Chained provider reasoning (summary bursts with nothing between them) reads
 * as one thought, so it renders as one: durations sum, and the body joins the
 * texts in order.
 */
const MergedThoughts = memo(function MergedThoughts({ parts }: { parts: ReadonlyArray<ThinkingPart> }) {
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
}, (prev, next) => sameMembers(prev.parts, next.parts))

const PartView = memo(function PartView({
  part,
  markdown,
  onDecideGate,
  onForkOntoBranch,
  onAdoptBranch,
  streamingText = false
}: {
  part: ContentPart
  markdown: boolean
  streamingText?: boolean
  onDecideGate?: (gateId: string, decision: GateDecision) => void
  onForkOntoBranch?: () => void | Promise<void>
  onAdoptBranch?: () => void | Promise<void>
}) {
  switch (part._tag) {
    case "Text": {
      return <MessageText text={part.text} markdown={markdown} streaming={streamingText} />
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
      return null
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
})

/**
 * Render a turn's parts, collapsing runs of ≥ `COLLAPSE_MIN` consecutive tool
 * calls (with no text between) into a single `ToolGroup`. Anything else renders
 * in program order.
 */
function renderParts(
  parts: ReadonlyArray<ContentPart>,
  markdown: boolean,
  {
    onDecideGate,
    onForkOntoBranch,
    onAdoptBranch,
    afterPart,
    keyOffset = 0,
    streamingTextIndex = -1
  }: {
    onDecideGate?: (gateId: string, decision: GateDecision) => void
    onForkOntoBranch?: () => void | Promise<void>
    onAdoptBranch?: () => void | Promise<void>
    afterPart?: { readonly index: number; readonly content: ReactNode }
    /** Absolute offset when a mega-turn's prefix is collapsed. */
    keyOffset?: number
    streamingTextIndex?: number
  }
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
  const insertAfter = (index: number) => {
    if (afterPart?.index !== index) return
    flush()
    flushImgs()
    flushThoughts()
    out.push(<div key={`after-${index}`}>{afterPart.content}</div>)
  }
  parts.forEach((part, localIndex) => {
    const i = localIndex + keyOffset
    if (isGroupableTool(part)) {
      flushImgs()
      flushThoughts()
      if (run.length === 0) runStart = i
      run.push(part)
      insertAfter(i)
      return
    }
    if (part._tag === "Image") {
      flush()
      flushThoughts()
      if (imgs.length === 0) imgStart = i
      imgs.push(part)
      insertAfter(i)
      return
    }
    if (part._tag === "Thinking") {
      flush()
      flushImgs()
      if (thoughts.length === 0) thoughtStart = i
      thoughts.push(part)
      insertAfter(i)
      return
    }
    flush()
    flushImgs()
    flushThoughts()
    out.push(
      <PartView
        key={i}
        part={part}
        markdown={markdown}
        streamingText={i === streamingTextIndex}
        onDecideGate={onDecideGate}
        onForkOntoBranch={onForkOntoBranch}
        onAdoptBranch={onAdoptBranch}
      />
    )
    insertAfter(i)
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
  onForkOntoBranch,
  onAdoptBranch,
  afterPart
}: {
  message: Message
  /** Canonical provider identity for the assistant eyebrow. */
  providerId?: ProviderId | null
  onDecideGate?: (gateId: string, decision: GateDecision) => void
  /** Fork a drifted direct session's work onto a new worktree session. */
  onForkOntoBranch?: () => void | Promise<void>
  /** Adopt the drifted checkout's branch into this session. */
  onAdoptBranch?: () => void | Promise<void>
  /** Insert transcript-owned UI immediately after one absolute part index. */
  afterPart?: { readonly index: number; readonly content: ReactNode }
}) {
  const isAssistant = message.role === "assistant"
  // From the FULL part list, not the visible slice: a mega-turn's collapsed
  // prefix can hold the Plan part whose presence suppresses the submit card.
  const [showAllParts, setShowAllParts] = useState(false)
  const hiddenParts = showAllParts ? 0 : hiddenPrefixLength(message.parts.length)
  const visibleParts =
    hiddenParts > 0 ? message.parts.slice(hiddenParts) : message.parts
  const lastPart = message.parts[message.parts.length - 1]
  const streamingTextIndex =
    isAssistant && message.streaming && lastPart?._tag === "Text"
      ? message.parts.length - 1
      : -1
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
      {renderParts(visibleParts, isAssistant, {
        onDecideGate,
        onForkOntoBranch,
        onAdoptBranch,
        afterPart,
        keyOffset: hiddenParts,
        streamingTextIndex
      })}
    </div>
  )
}

export const MessageTurn = memo(MessageTurnImpl)
