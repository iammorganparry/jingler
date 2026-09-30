import { updateTranscriptRowKeys } from "./transcript-row-keys.js"
import { defaultProps } from "../lib/default-props.js"
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"
import { planDocumentToPlan } from "@jingler/core"
import type {
  AgentEndpointCatalog,
  AgentEndpointId,
  AgentRuntimeId,
  Attachment,
  ContextBreakdown,
  GateDecision,
  Message,
  McpConfigEntry,
  McpRemoteAuth,
  McpServer,
  PermissionMode,
  PlanDocument,
  ProviderCatalog,
  ProviderConnectionId,
  ProviderId,
  ProviderModelId,
  QuestionAnswer,
  QuestionRequest,
  ReasoningEffort,
  ReasoningSetting,
  Skill
} from "@jingler/core"
import { type VirtualItem, useVirtualizer } from "@tanstack/react-virtual"
import { useHotkeys } from "react-hotkeys-hook"
import { ArrowUp, Lock, RotateCcw } from "lucide-react"
import type { ArchiveReason, ContextPhase } from "@jingler/core"
import { cn } from "../lib/cn.js"
import { atLeast, useWidthTier } from "../hooks/width-tier.js"
import { Button } from "../components/button.js"
import { Composer, type ComposerCodeReference } from "../composites/composer.js"
import { ThinkingOrb } from "../components/loading.js"
import { QuestionCard } from "../composites/question-card.js"
import { QueuedMessageRow } from "../composites/queued-message-row.js"
import {
  MessageTurn,
  PlanProgressContext,
  ToolStopContext
} from "../composites/message-turn.js"
import { PlanApprovalCard } from "../composites/plan-card.js"
import { createMessageRailPreview, MessageScroller } from "../composites/beui/messages.js"
import type { PreviewRailItem } from "../components/beui/overlays.js"
import { ArchivedBanner } from "../composites/archived-banner.js"
import { ContextMeter } from "../composites/context-meter.js"
import { RunStats } from "../composites/run-stats.js"

/**
 * How many queued messages show before the list collapses behind a "+N more".
 *
 * The queue sits between the transcript and the composer, so its height comes
 * straight out of both. Routing an adversarial review's findings queues one turn
 * PER FINDING — twenty of them pushed the composer off the bottom of the window
 * entirely. Five is enough to see what's next without the list becoming the page.
 */
const QUEUE_PREVIEW = 5
const ESTIMATED_TURN_HEIGHT = 140

/**
 * How much raw text feeds one rail preview. The rail shows at most ~144
 * normalized chars (title + description), so collecting more per message is
 * pure waste — and that waste was load-bearing: `messages` gets a new identity
 * on every streamed token, the rail memo re-runs each time, and joining every
 * Text part of every turn made it O(full transcript) per token — megabytes of
 * string churn a second on the 5MB transcripts this view is benchmarked
 * against. Generous headroom because createMessageRailPreview collapses
 * whitespace after us.
 */
const RAIL_PREVIEW_SOURCE_CHARS = 400

/** First `RAIL_PREVIEW_SOURCE_CHARS` chars of a turn's Text parts, joined. */
const railText = (message: Message): string => {
  let text = ""
  for (const part of message.parts) {
    if (part._tag !== "Text") continue
    text = text.length > 0 ? `${text} ${part.text}` : part.text
    if (text.length >= RAIL_PREVIEW_SOURCE_CHARS) return text.slice(0, RAIL_PREVIEW_SOURCE_CHARS)
  }
  return text
}

export const isRetryablePromptFailure = (
  messages: ReadonlyArray<Message>,
  index: number
): boolean => {
  if (index !== messages.length - 1) return false
  const failed = messages[index]
  const failure = failed?.parts.at(-1)
  return failed?.role === "assistant" &&
    failure?._tag === "Text" &&
    failure.text.startsWith("pi prompt failed") &&
    messages[index - 1]?.role === "user"
}

export const latestAssistantMessageIndex = (messages: ReadonlyArray<Message>): number =>
  messages.findLastIndex((message) => message.role === "assistant")

/**
 * The transcript row the reader is "on": pinned to the ends within 56px of
 * either edge, otherwise whichever rendered row's centre is nearest the
 * viewport's centre. Undefined when nothing is rendered yet.
 */
const activeVirtualItemFor = (
  viewport: HTMLElement | null,
  items: ReadonlyArray<VirtualItem>
): VirtualItem | undefined => {
  if (!viewport || items.length === 0) return undefined
  if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 56) return items.at(-1)
  if (viewport.scrollTop <= 56) return items[0]
  const centre = viewport.scrollTop + viewport.clientHeight / 2
  const distance = (item: VirtualItem) => Math.abs(item.start + item.size / 2 - centre)
  return items.reduce((nearest, item) => (distance(item) < distance(nearest) ? item : nearest))
}

/**
 * Which rail tick to light up: the user turn at or above the reader's current
 * row. Before the virtualizer has measured anything, the row is the latest
 * assistant turn (what the anchor effect below scrolls to).
 */
const activeRailIdFor = (
  activeIndex: number | undefined,
  itemKeys: ReadonlyArray<string>,
  messages: ReadonlyArray<Message>,
  userMessageIndexes: ReadonlyArray<number>
): string | undefined => {
  const index = activeIndex ?? Math.max(latestAssistantMessageIndex(messages), 0)
  const userIndex = userMessageIndexes.findLast(i => i <= index) ?? userMessageIndexes[0]
  return userIndex === undefined ? undefined : itemKeys[userIndex]
}

/** Shift+Tab cycles Jingler's provider-neutral permission modes. */
const MODE_CYCLE: ReadonlyArray<PermissionMode> = ["ask", "accept-edits", "auto"]
const MODE_CYCLE_WITH_PLAN: ReadonlyArray<PermissionMode> = [...MODE_CYCLE, "plan"]
const PLANNOTATOR_PLAN_TOOLS = new Set(["plannotator_submit_plan", "plannotator_update_plan"])
const isPlannotatorPlanTool = (part: Message["parts"][number]): boolean =>
  part._tag === "Tool" &&
  PLANNOTATOR_PLAN_TOOLS.has(part.tool.name) &&
  (part.tool.status === "success" ||
    (part.tool.name === "plannotator_submit_plan" && part.tool.status === "running"))

export const planTranscriptAnchorIndex = (messages: ReadonlyArray<Message>): number =>
  messages.findLastIndex((message) => message.parts.some(isPlannotatorPlanTool))

export interface ConversationViewProps {
  messages: ReadonlyArray<Message>
  /** Older turns remain before `messages[0]` — show the "Load earlier" control. */
  hasMoreHistory?: boolean
  /** An older page is being fetched — spinner + disabled control. */
  loadingHistory?: boolean
  /** Page the next window of older turns onto the front of `messages`. */
  onLoadEarlier?: () => void
  mode: PermissionMode
  skills?: ReadonlyArray<Skill>
  files?: ReadonlyArray<string>
  onAddMcp?: (name: string, entry: McpConfigEntry) => Promise<void>
  mcpServers?: ReadonlyArray<McpServer>
  onSetMcpApiKey?: (name: string, apiKey: string) => Promise<void>
  onSetMcpAuth?: (name: string, auth: McpRemoteAuth) => Promise<void>
  onAuthorizeMcp?: (name: string) => Promise<void>
  paused?: boolean
  /** Git branch backing the session's worktree, shown in the composer. */
  branch?: string
  /** The detached task worktree is waiting for its semantic branch name. */
  branchPending?: boolean
  /** Repository backing the session, shown at the composer's bottom-left. */
  repo?: string
  /** Live uncommitted worktree state for the composer's dirty badge. */
  diff?: { files: number; added: number; removed: number } | null
  environments?: ReadonlyArray<import("@jingler/core").Environment>
  environmentId?: string
  environmentPending?: boolean
  onSetEnvironment?: (environmentId?: string) => void
  providerCatalog?: ProviderCatalog | null
  agentEndpointCatalog?: AgentEndpointCatalog | null
  endpointId?: AgentEndpointId | null
  connectionId?: ProviderConnectionId | null
  providerId?: ProviderId | null
  modelId?: ProviderModelId | null
  onSetModel?: (selection: {
    runtimeId: AgentRuntimeId
    endpointId: AgentEndpointId
    connectionId?: ProviderConnectionId
    providerId: ProviderId
    modelId: ProviderModelId
  }) => void
  onSend?: (text: string, images?: ReadonlyArray<Attachment>) => void
  /** Replay the latest failed Pi prompt without consuming the current composer draft. */
  onRetryPrompt?: () => void
  /** Halt the running agent — the Stop button, and Escape outside the composer. */
  onStop?: () => void
  /** The agent is producing a turn — the composer queues messages instead of blocking. */
  busy?: boolean
  /** Tokens currently occupying the main agent's context window. */
  tokens?: number
  /** Estimated composition of the provider-reported working context. */
  contextBreakdown?: ContextBreakdown | null
  /**
   * Where compaction fires for this session, in tokens. Null when the harness
   * reports no usage — the meter then renders nothing rather than an empty bar
   * that would read as "plenty of room left".
   */
  contextTriggerAt?: number | null
  /** What the manager will actually do — the meter must not infer this itself. */
  contextPhase?: ContextPhase
  /** A summary is being built right now. */
  contextPreparing?: boolean
  /** A digest is prepared; the next turn will reseed the conversation. */
  contextDigestReady?: boolean
  /** Automatic compaction has given up on this session after repeated failures. */
  contextStalled?: boolean
  /** A ready digest is being held back because the session is mid-task. */
  contextHeld?: boolean
  /** One line naming what is in flight, for the meter's tooltip. */
  contextHeldReason?: string | null
  /** Compact this session now, ahead of the budget. */
  onCompactNow?: () => void
  /** Epoch ms the current run started, or null when idle — drives the elapsed timer. */
  runStartedAt?: number | null
  /**
   * Messages the operator queued while the agent was busy (sent FIFO once it's
   * free). Each carries a stable `id`, and every action below addresses it —
   * never a position. The queue mutates itself while these rows are on screen (a
   * message is handed to the running turn at each tool boundary), so an index
   * captured at render time can point at a different message by the time it is used.
   */
  queued?: ReadonlyArray<{ id: string; text: string; images: ReadonlyArray<Attachment> }>
  /** Drop a queued message before it's sent. */
  onUnqueue?: (id: string) => void
  /**
   * Interrupt the current turn and run a queued message now — lets the operator
   * steer mid-stream instead of waiting for the turn to finish.
   */
  onSendNow?: (id: string) => void
  /**
   * Fork a queued message into a FRESH chat on the operator's default model
   * instead of running it in this conversation — the escape hatch for "this is a
   * separate job that shouldn't inherit 200k tokens of unrelated context".
   */
  onHandoffQueued?: (id: string) => void
  /** Rewrite a queued message in place, before it is ever sent. */
  onEditQueued?: (id: string, text: string) => void
  /** What the hand-off targets, for its tooltip (e.g. "a new chat on Opus 4.6"). */
  handoffHint?: string
  /**
   * The queued message being handed to the running turn right now, if any. Its
   * row drops every action: the agent already has the text, so acting on it would
   * run the same prompt twice.
   */
  steeringId?: string | null
  onDecideGate?: (gateId: string, decision: GateDecision) => void
  onSetMode?: (mode: PermissionMode) => void
  reasoningEffort?: ReasoningEffort
  thinkingEnabled?: boolean
  onSetReasoning?: (reasoning?: ReasoningSetting) => void
  /** A pending AskUserQuestion — replaces the composer with the question card. */
  question?: QuestionRequest | null
  onAnswerQuestion?: (requestId: string, answers: ReadonlyArray<QuestionAnswer>) => void
  /** Open the full read-only native plan projection. */
  onOpenPlanReview?: (stepId?: string) => void
  /** Fork a drifted direct session's work onto a new worktree session (BranchDrift banner). */
  onForkOntoBranch?: () => void | Promise<void>
  /** Adopt the drifted checkout's branch into this session (BranchDrift banner). */
  onAdoptBranch?: () => void | Promise<void>
  /**
   * Read-only native projection of Plannotator checklist progress.
   */
  planDocument?: PlanDocument | null
  /**
   * When set, the session is archived (its PR merged/closed): a banner is shown,
   * the transcript dims to read-only, and the composer is replaced by a locked bar.
   */
  archived?: {
    reason: ArchiveReason
    prNumber: number | null
    base?: string | null
    onRestore?: () => void
    onDelete?: () => void
  }
  /** One-shot draft to seed the composer with (task prefilled from an issue). */
  initialDraft?: string
  /**
   * Lift the composer's draft out of the view, so it survives the session-keyed
   * unmount. Omit for the uncontrolled composer (stories).
   */
  draft?: string
  onDraftChange?: (value: string) => void
  draftAttachments?: ReadonlyArray<Attachment>
  onDraftAttachmentsChange?: (attachments: ReadonlyArray<Attachment>) => void
  draftCodeReferences?: ReadonlyArray<ComposerCodeReference>
  onDraftCodeReferenceRemove?: (index: number) => void
  onDraftCodeReferencesClear?: () => void
  /** Put the caret in the composer when this view becomes the one on screen. */
  autoFocusComposer?: boolean
  /** Identity of "the one on screen" — the session id. */
  focusKey?: string
  /** Disable sending while preserving the model picker as the recovery path. */
  composerDisabledReason?: string
  /** Whether the session Files workspace follows this chat's agent mutations. */
  followAgent?: boolean
  /** Toggle follow mode; enabling may present Files beside the conversation. */
  onToggleFollowAgent?: (enabled: boolean) => void
}

/**
 * The session workspace pane: the mode bar + interleaved transcript + composer,
 * with the live Changes rail (the worktree's real diff). Purely presentational —
 * the renderer's conversation machine feeds it `messages`/`patch` + callbacks.
 * New turns autoscroll to the latest assistant output and keep following while
 * it streams.
 */
export function ConversationView(props:  ConversationViewProps) {
  const { messages, hasMoreHistory, loadingHistory, onLoadEarlier, mode, skills, files, paused, branch, branchPending, repo, diff, environments, environmentId, environmentPending, onSetEnvironment, providerCatalog, agentEndpointCatalog, endpointId, connectionId, providerId, modelId, onSetModel, onSend, onRetryPrompt, onStop, busy, tokens, contextBreakdown, contextTriggerAt, contextPhase, contextPreparing, contextDigestReady, contextStalled, contextHeld, contextHeldReason, onCompactNow, runStartedAt, queued, onUnqueue, onSendNow, onHandoffQueued, onEditQueued, handoffHint, steeringId, onDecideGate, onSetMode, onAddMcp, mcpServers, onSetMcpApiKey, onSetMcpAuth, onAuthorizeMcp, reasoningEffort, thinkingEnabled, onSetReasoning, question, onAnswerQuestion, onOpenPlanReview, onForkOntoBranch, onAdoptBranch, planDocument, draft, onDraftChange, draftAttachments, onDraftAttachmentsChange, draftCodeReferences, onDraftCodeReferenceRemove, onDraftCodeReferencesClear, autoFocusComposer, focusKey, composerDisabledReason, followAgent, onToggleFollowAgent, archived, initialDraft } = defaultProps(props, {
    hasMoreHistory: false,
    loadingHistory: false,
    skills: [],
    files: [],
    paused: false,
    branchPending: false,
    diff: null,
    connectionId: null,
    providerId: null,
    modelId: null,
    busy: false,
    tokens: 0,
    contextBreakdown: null,
    contextTriggerAt: null,
    contextPhase: "unknown",
    contextPreparing: false,
    contextDigestReady: false,
    contextStalled: false,
    contextHeld: false,
    contextHeldReason: null,
    runStartedAt: null,
    queued: [],
    steeringId: null,
    planDocument: null,
    followAgent: false
  })

function renderSessionAnalytics() {
             return (!archived && (busy || runStartedAt !== null || tokens > 0) && (
            <div className="mb-1.5 flex min-w-0 flex-wrap items-center justify-end gap-x-2.5 gap-y-1">
              <ContextMeter
                tokens={tokens}
                breakdown={contextBreakdown}
                triggerAt={contextTriggerAt}
                phase={contextPhase}
                preparing={contextPreparing}
                digestReady={contextDigestReady}
                stalled={contextStalled}
                held={contextHeld}
                heldReason={contextHeldReason}
                onCompactNow={onCompactNow}
              />
              <RunStats startedAt={runStartedAt} busy={busy} />
            </div>
          ))
           }

         function renderComposerArea() {

  function queuedMessageActions(item: NonNullable<ConversationViewProps["queued"]>[number]) {
    return {
      ...(onSendNow && busy ? { onSendNow: () => onSendNow(item.id) } : {}),
      ...(onHandoffQueued ? { onHandoff: () => onHandoffQueued(item.id) } : {}),
      ...(onEditQueued ? { onEdit: (text: string) => onEditQueued(item.id, text) } : {}),
      ...(onUnqueue ? { onRemove: () => onUnqueue(item.id) } : {})
    }
  }
  const renderQueuedMessage = ((item: NonNullable<ConversationViewProps["queued"]>[number]) => {
                    // In flight: the row still shows (nothing is confirmed yet) but
                    // every action is withheld, because the agent already has this
                    // text and acting on it would run the prompt a second time.
                    const sending = item.id === steeringId
                    const actions = sending ? {} : queuedMessageActions(item)
                    return (
                      <QueuedMessageRow
                        key={item.id}
                        text={item.text}
                        images={item.images.length}
                        handoffHint={handoffHint}
                        sending={sending}
                        {...actions}
                      />
                    )
                  }) satisfies Parameters<typeof queued.map>[0]

           return (<div className={cn("flex-none pb-[18px] pt-[11px]", gutter)}>
          <div className="mx-auto w-full max-w-[760px]">
            {/* Live session analytics — elapsed time + current context size, right
              above the composer so it stays visible while the user works. */}
          {renderSessionAnalytics()}
          {archived ? (
            <div className="flex items-center gap-2.5 rounded-xl border border-line bg-sunken px-[14px] py-3 text-[12.5px] text-muted-foreground">
              <Lock size={14} className="flex-none text-dim" />
              <span className="min-w-0 flex-1">
                Composer disabled — this session is archived.{" "}
                <button
                  type="button"
                  onClick={archived.onRestore}
                  className="text-blue outline-none hover:underline"
                >
                  Restore it
                </button>{" "}
                to send messages.
              </span>
              {archived.onRestore && (
                <Button variant="secondary" size="sm" className="gap-1.5" onClick={archived.onRestore}>
                  <RotateCcw size={12} />
                  Restore
                </Button>
              )}
            </div>
          ) : question ? (
            <QuestionCard
              request={question}
              onSubmit={(answers) => onAnswerQuestion?.(question.id, answers)}
            />
          ) : (
            <>
              {queued.length > 0 && (
                <div
                  className={cn(
                    "mb-2 flex flex-col gap-1.5",
                    // Expanding must not reintroduce the bug it fixes: a 20-item
                    // queue scrolls within its own box rather than growing the
                    // composer off the screen again.
                    queueExpanded && "max-h-[240px] overflow-y-auto"
                  )}
                >
                  {/*
                    Capped, because this list sits between the transcript and the
                    composer and grows without limit — routing a review's findings
                    queues one turn per finding, and twenty of them pushed the
                    composer clean off the screen. `slice(0, n)` keeps each item's
                    index intact, which matters: `onSendNow`/`onUnqueue` address
                    the queue positionally.
                  */}
                  {/*
                    Keyed by id, not by position. A positional key remounts every
                    row below the head each time the queue flushes one into the
                    running turn — which throws away the text of a row the operator
                    is part-way through editing, at a moment they did not cause.
                  */}
                  {queued.slice(0, queueLimit).map(renderQueuedMessage)}
                  {queued.length > QUEUE_PREVIEW && (
                    <button
                      type="button"
                      onClick={() => setQueueExpanded((v) => !v)}
                      className="self-start rounded px-1.5 py-0.5 text-[11.5px] text-dim outline-none transition-colors hover:text-text focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {queueExpanded
                        ? "Show fewer"
                        : `+${queued.length - QUEUE_PREVIEW} more queued`}
                    </button>
                  )}
                </div>
              )}
              <Composer
                skills={skills}
                files={files}
                onAddMcp={onAddMcp}
                mcpServers={mcpServers}
                onSetMcpApiKey={onSetMcpApiKey}
                onSetMcpAuth={onSetMcpAuth}
                onAuthorizeMcp={onAuthorizeMcp}
                paused={paused}
                branch={branch}
                branchPending={branchPending}
                repo={repo}
                diff={diff}
                environments={environments}
                environmentId={environmentId}
                environmentPending={environmentPending}
                onSetEnvironment={onSetEnvironment}
                busy={busy}
                disabledReason={composerDisabledReason}
                providerCatalog={providerCatalog}
                agentEndpointCatalog={agentEndpointCatalog}
                endpointId={endpointId}
                connectionId={connectionId}
                providerId={providerId}
                modelId={modelId}
                onSetModel={onSetModel}
                mode={mode}
                onSetMode={onSetMode}
                followAgent={followAgent}
                onToggleFollowAgent={onToggleFollowAgent}
                reasoningEffort={reasoningEffort}
                thinkingEnabled={thinkingEnabled}
                onSetReasoning={onSetReasoning}
                allowPlan
                onSend={onSend}
                onStop={onStop}
                initialValue={initialDraft}
                value={draft}
                onValueChange={onDraftChange}
                attachments={draftAttachments}
                onAttachmentsChange={onDraftAttachmentsChange}
                codeReferences={draftCodeReferences}
                onCodeReferenceRemove={onDraftCodeReferenceRemove}
                onCodeReferencesClear={onDraftCodeReferencesClear}
                planDocument={planDocument ?? undefined}
                onOpenPlanStage={(stageId) => onOpenPlanReview?.(stageId)}
                autoFocus={autoFocusComposer}
                focusKey={focusKey}
              />
            </>
          )}
          </div>
        </div>)
         }

  // 30px each side is a comfortable reading gutter at 760px and a tenth of the
  // pane at 350px. The transcript and the composer share the value so their
  // left edges stay aligned — that alignment is what makes the composer read as
  // the bottom of the same column rather than a separate strip.
  const gutter = atLeast(useWidthTier(), "mid") ? "px-[30px]" : "px-3"
  const [viewport, setViewport] = useState<HTMLElement | null>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  // MessageScroller owns live-edge following. Keeping the current decision in
  // state lets history paging pause it without racing the scroller's observer.
  const [following, setFollowing] = useState(true)
  const anchoredAssistantKey = useRef<string | undefined>(undefined)
  const [queueExpanded, setQueueExpanded] = useState(false)
  const queueLimit = queueExpanded ? queued.length : QUEUE_PREVIEW
  const planAnchorIndex = planTranscriptAnchorIndex(messages)
  const planAnchorPartIndex = planAnchorIndex < 0
    ? -1
    : messages[planAnchorIndex]!.parts.findLastIndex(isPlannotatorPlanTool)
  const showPlanTranscriptCard = planDocument !== null &&
    planAnchorIndex >= 0 &&
    planDocument.plan.sections.length + planDocument.plan.stages.length > 0

  // Shift+Tab cycles the HITL mode (works while typing in the composer). Plan
  // is part of the same Jingler-owned contract for every certified model.
  //
  // Scoped to THIS pane via the ref `useHotkeys` returns (attached to the root
  // below), so it only fires while focus is inside this view. A split view
  // mounts one ConversationView per pane, and an unscoped document-level binding
  // fires in EVERY mounted pane at once — so a single Shift+Tab cycled every
  // composer's mode, not just the focused one's.
  const cycle = MODE_CYCLE_WITH_PLAN
  const modeHotkeyRef = useHotkeys<HTMLDivElement>(
    "shift+tab",
    () => {
      const i = cycle.indexOf(mode)
      onSetMode?.(cycle[(i + 1) % cycle.length]!)
    },
    { enableOnFormTags: true, preventDefault: true },
    [mode, onSetMode, cycle]
  )

  // Escape halts a running agent. Deliberately NOT `enableOnFormTags` (unlike
  // Shift+Tab above): the composer owns Escape while you're typing, where it
  // closes the / and @ autocomplete menus — so binding it there would both
  // dismiss the menu and kill the run on one keypress. Escape therefore only
  // fires with focus outside the composer, and only while there's a run to stop.
  useHotkeys(
    "esc",
    () => onStop?.(),
    { enabled: busy && !archived && onStop !== undefined },
    [busy, archived, onStop]
  )

  // Stable opaque row identities. Streaming replaces the last message on every
  // token, but not its position, so equal-length updates reuse this array in
  // O(1). Loading history allocates only the prepended prefix and preserves the
  // existing suffix keys — including legacy rows with duplicate message ids.
  const itemKeyState = useRef<{
    messages: ReadonlyArray<Message>
    keys: ReadonlyArray<string>
    next: number
  }>({ messages: [], keys: [], next: 0 })
  itemKeyState.current = updateTranscriptRowKeys(itemKeyState.current, messages)
  const itemKeys = itemKeyState.current.keys
  const getItemKey = useCallback((index: number) => itemKeys[index]!, [itemKeys])
  // Per-item identity reuse: `messages` gets a new identity on every streamed
  // token, so this memo re-runs per token — but only the LIVE turn's preview
  // text actually changes. Reusing the previous item object (and, when nothing
  // changed at all, the previous array) keeps the rail's props referentially
  // stable, so the memoised PreviewRail skips per-token re-renders of its
  // tick + preview-card tree.
  const userMessageIndexes = useMemo(() => messages.flatMap((message, index) =>
    message.role === "user" ? [index] : []
  ), [messages])
  const previousRailItems = useRef<ReadonlyArray<PreviewRailItem>>([])
  const messageRailItems = useMemo(() => {
    const previous = previousRailItems.current
    let reusedAll = previous.length === userMessageIndexes.length
    const next = userMessageIndexes.map((messageIndex, userIndex) => {
      const message = messages[messageIndex]!
      const responseTurn = messages.slice(messageIndex + 1).find(candidate => candidate.role === "assistant")
      const item = {
        id: itemKeys[messageIndex]!,
        ...createMessageRailPreview(railText(message), responseTurn ? railText(responseTurn) : ""),
        ariaLabel: `Go to user message ${userIndex + 1} of ${userMessageIndexes.length}`
      }
      const old = previous[userIndex]
      if (
        old !== undefined &&
        old.id === item.id &&
        old.label === item.label &&
        old.description === item.description &&
        old.ariaLabel === item.ariaLabel
      ) return old
      reusedAll = false
      return item
    })
    const result = reusedAll ? previous : next
    previousRailItems.current = result
    return result
  }, [itemKeys, messages, userMessageIndexes])

  // Virtualize the transcript so large sessions stay fast. Heights are dynamic
  // (markdown, tool cards, diffs) so we measure each turn as it renders/grows.
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => viewport,
    enabled: viewport !== null && messages.length > 0,
    // Start at the live edge instead of rendering the oldest rich rows just to discard them.
    initialOffset: () => following
      ? Math.max(0, messages.length * ESTIMATED_TURN_HEIGHT - (viewport?.clientHeight ?? 0))
      : 0,
    estimateSize: () => ESTIMATED_TURN_HEIGHT,
    getItemKey,
    overscan: 2
  })
  const virtualItems = virtualizer.getVirtualItems()
  const activeVirtualItem = activeVirtualItemFor(viewport, virtualItems)
  const activeRailId = activeRailIdFor(activeVirtualItem?.index, itemKeys, messages, userMessageIndexes)

  useLayoutEffect(() => {
    const index = latestAssistantMessageIndex(messages)
    const key = itemKeys[index]
    if (key === undefined || key === anchoredAssistantKey.current) return
    const frame = requestAnimationFrame(() => {
      anchoredAssistantKey.current = key
      setFollowing(index === messages.length - 1)
      virtualizer.scrollToIndex(index, { align: "end" })
    })
    return () => cancelAnimationFrame(frame)
  }, [itemKeys, messages, virtualizer])

  // Referentially stable so the memoised PreviewRail isn't defeated by a fresh
  // closure per render. `virtualizer` is a stable instance across renders.
  const handleRailSelect = useCallback((item: PreviewRailItem) => {
    const index = itemKeys.indexOf(item.id)
    if (index < 0) return
    const last = index === messages.length - 1
    setFollowing(last)
    virtualizer.scrollToIndex(index, { align: last ? "end" : "center" })
  }, [itemKeys, messages.length, virtualizer])

  // Preserve the viewport across a "Load earlier" prepend: capture the scroll
  // metrics at click, then after the older page lands add back exactly the height
  // it introduced above the reader. Anchoring by height delta (not an index) is
  // robust to the new rows still sitting at their estimated size — they re-measure
  // and self-correct as they scroll into view.
  const restoreScroll = useRef<{ height: number; top: number } | null>(null)
  const handleLoadEarlier = useCallback(() => {
    const el = viewport
    if (el) restoreScroll.current = { height: el.scrollHeight, top: el.scrollTop }
    // Never let live-edge following yank the reader back down mid-prepend.
    setFollowing(false)
    onLoadEarlier?.()
  }, [onLoadEarlier, viewport])

  // Runs on the same `messages` change as the prepend. Following is paused, so
  // an errored load prepends nothing and equal heights make this a no-op.
  useLayoutEffect(() => {
    const el = viewport
    const saved = restoreScroll.current
    if (!el || !saved) return
    el.scrollTop = el.scrollHeight - saved.height + saved.top
    restoreScroll.current = null
  }, [messages, viewport])

  return (
    <div ref={modeHotkeyRef} className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {archived && (
          <ArchivedBanner
            reason={archived.reason}
            prNumber={archived.prNumber}
            base={archived.base}
            onRestore={archived.onRestore}
            onDelete={archived.onDelete}
          />
        )}
        <MessageScroller
          navigation="rail"
          navigationItems={messageRailItems}
          navigationActiveId={activeRailId}
          onNavigationSelect={handleRailSelect}
          followOutput={following && messages.length > 0}
          onFollowChange={setFollowing}
          busy={busy}
          viewportRef={setViewport}
          viewportTestId="conversation-scroll"
          className="flex-1"
          viewportClassName={cn(
            // `both-edges` reserves the scrollbar gutter symmetrically so the
            // centered content stays on the window's centre axis — matching the
            // composer below (which has no scrollbar) exactly.
            "py-[26px] [scrollbar-gutter:stable_both-edges]",
            gutter,
            archived && "opacity-60"
          )}
        >
          {/* Sits above the virtualized list, at the very top of the scroll —
              the reader meets it only after scrolling back to the oldest loaded
              turn. Older turns page in on click; the viewport is held steady by
              the anchor effect above. */}
          {hasMoreHistory && (
            <div className="mx-auto mb-2 flex w-full max-w-[760px] justify-center">
              <button
                type="button"
                data-testid="load-earlier"
                onClick={handleLoadEarlier}
                disabled={loadingHistory}
                className="flex items-center gap-1.5 rounded-full border border-line bg-sunken px-3 py-1 text-[12px] text-muted-foreground outline-none transition-colors hover:text-foreground disabled:opacity-60"
              >
                <ArrowUp size={13} className="flex-none" />
                {loadingHistory ? "Loading earlier messages…" : "Load earlier messages"}
              </button>
            </div>
          )}
          <PlanProgressContext.Provider value={planDocument}>
          <ToolStopContext.Provider value={busy ? (onStop ?? null) : null}>
          <div
            ref={transcriptRef}
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const m = messages[item.index]!
              const retry = onRetryPrompt !== undefined && isRetryablePromptFailure(messages, item.index)
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${item.start}px)`, contain: "layout" }}
                >
                  {/* Centered content column (same width as the composer below). */}
                  <div className="mx-auto w-full max-w-[760px] pb-6">
                    <MessageTurn
                      message={m}
                      providerId={m.providerId ?? providerId}
                      onDecideGate={onDecideGate}
                      onForkOntoBranch={onForkOntoBranch}
                      onAdoptBranch={onAdoptBranch}
                      afterPart={planDocument !== null && showPlanTranscriptCard && item.index === planAnchorIndex
                        ? {
                            index: planAnchorPartIndex,
                            content: (
                              <div data-testid="plannotator-transcript-card">
                                <PlanApprovalCard
                                  plan={planDocumentToPlan(planDocument)}
                                  document={planDocument}
                                  onOpenReview={onOpenPlanReview}
                                />
                              </div>
                            )
                          }
                        : undefined}
                    />
                    {retry && (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="mt-3 gap-1.5"
                        onClick={onRetryPrompt}
                      >
                        <RotateCcw size={12} />
                        Retry prompt
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          </ToolStopContext.Provider>
          </PlanProgressContext.Provider>
          {busy ? (
            <div className="mx-auto mt-1 flex w-full max-w-[760px] justify-start" data-testid="chat-thinking-orb">
              <ThinkingOrb />
            </div>
          ) : null}
        </MessageScroller>

        {/* Same gutter + centered max-width as the transcript column above. */}
        {renderComposerArea()}
      </div>
    </div>
  )
}
