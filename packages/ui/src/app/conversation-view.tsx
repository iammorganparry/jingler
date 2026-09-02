import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"
import { planDocumentToPlan } from "@jingler/core"
import type {
  Attachment,
  GateDecision,
  Message,
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
import { useVirtualizer } from "@tanstack/react-virtual"
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
  connectionId?: ProviderConnectionId | null
  providerId?: ProviderId | null
  modelId?: ProviderModelId | null
  onSetModel?: (selection: {
    connectionId: ProviderConnectionId
    providerId: ProviderId
    modelId: ProviderModelId
  }) => void
  onSend?: (text: string, images?: ReadonlyArray<Attachment>) => void
  /** Halt the running agent — the Stop button, and Escape outside the composer. */
  onStop?: () => void
  /** The agent is producing a turn — the composer queues messages instead of blocking. */
  busy?: boolean
  /** Tokens currently occupying the main agent's context window. */
  tokens?: number
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
 * New turns autoscroll to the top of the viewport so a streaming response has
 * room to fill downward (the design's "room to follow").
 */
export function ConversationView({
  messages,
  hasMoreHistory = false,
  loadingHistory = false,
  onLoadEarlier,
  mode,
  skills = [],
  files = [],
  paused = false,
  branch,
  branchPending = false,
  repo,
  diff = null,
  environments,
  environmentId,
  environmentPending,
  onSetEnvironment,
  providerCatalog,
  connectionId = null,
  providerId = null,
  modelId = null,
  onSetModel,
  onSend,
  onStop,
  busy = false,
  tokens = 0,
  contextTriggerAt = null,
  contextPhase = "unknown",
  contextPreparing = false,
  contextDigestReady = false,
  contextStalled = false,
  contextHeld = false,
  contextHeldReason = null,
  onCompactNow,
  runStartedAt = null,
  queued = [],
  onUnqueue,
  onSendNow,
  onHandoffQueued,
  onEditQueued,
  handoffHint,
  steeringId = null,
  onDecideGate,
  onSetMode,
  reasoningEffort,
  thinkingEnabled,
  onSetReasoning,
  question,
  onAnswerQuestion,
  onOpenPlanReview,
  onForkOntoBranch,
  onAdoptBranch,
  planDocument = null,
  draft,
  onDraftChange,
  draftAttachments,
  onDraftAttachmentsChange,
  draftCodeReferences,
  onDraftCodeReferenceRemove,
  onDraftCodeReferencesClear,
  autoFocusComposer,
  focusKey,
  composerDisabledReason,
  followAgent = false,
  onToggleFollowAgent,
  archived,
  initialDraft
}: ConversationViewProps) {
  // 30px each side is a comfortable reading gutter at 760px and a tenth of the
  // pane at 350px. The transcript and the composer share the value so their
  // left edges stay aligned — that alignment is what makes the composer read as
  // the bottom of the same column rather than a separate strip.
  const gutter = atLeast(useWidthTier(), "mid") ? "px-[30px]" : "px-3"
  const scrollRef = useRef<HTMLElement>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  // MessageScroller owns live-edge following. Keeping the current decision in
  // state lets history paging pause it without racing the scroller's observer.
  const [following, setFollowing] = useState(true)
  const [queueExpanded, setQueueExpanded] = useState(false)
  const queueLimit = queueExpanded ? queued.length : QUEUE_PREVIEW
  const planAnchorIndex = planTranscriptAnchorIndex(messages)
  const planAnchorPartIndex = planAnchorIndex < 0
    ? -1
    : messages[planAnchorIndex]!.parts.findLastIndex(isPlannotatorPlanTool)
  const showPlanTranscriptCard = planDocument !== null &&
    planAnchorIndex >= 0 &&
    (planDocument.plan.sections.length > 0 || planDocument.plan.stages.length > 0)

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
  const previousKeys = itemKeyState.current
  if (previousKeys.messages !== messages) {
    const allocate = (count: number): ReadonlyArray<string> =>
      Array.from(
        { length: count },
        () => `transcript-row-${previousKeys.next++}`
      )
    let keys = previousKeys.keys
    if (messages.length !== previousKeys.messages.length) {
      const added = messages.length - previousKeys.messages.length
      if (
        added > 0 &&
        messages[added] === previousKeys.messages[0]
      ) {
        keys = [...allocate(added), ...previousKeys.keys]
      } else if (
        added > 0 &&
        messages[0] === previousKeys.messages[0]
      ) {
        keys = [...previousKeys.keys, ...allocate(added)]
      } else {
        keys = allocate(messages.length)
      }
    }
    itemKeyState.current = { messages, keys, next: previousKeys.next }
  }
  const itemKeys = itemKeyState.current.keys
  // Per-item identity reuse: `messages` gets a new identity on every streamed
  // token, so this memo re-runs per token — but only the LIVE turn's preview
  // text actually changes. Reusing the previous item object (and, when nothing
  // changed at all, the previous array) keeps the rail's props referentially
  // stable, so the memoised PreviewRail skips per-token re-renders of its
  // tick + preview-card tree.
  const previousRailItems = useRef<ReadonlyArray<PreviewRailItem>>([])
  const messageRailItems = useMemo(() => {
    const previous = previousRailItems.current
    let reusedAll = previous.length === messages.length
    const next = messages.map((message, index) => {
      const text = railText(message)
      const responseTurn = message.role === "user"
        ? messages.slice(index + 1).find(candidate => candidate.role === "assistant")
        : undefined
      const item = {
        id: itemKeys[index]!,
        ...createMessageRailPreview(text, responseTurn ? railText(responseTurn) : ""),
        ariaLabel: `Go to ${message.role} message ${index + 1} of ${messages.length}`
      }
      const old = previous[index]
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
  }, [itemKeys, messages])

  // Virtualize the transcript so large sessions stay fast. Heights are dynamic
  // (markdown, tool cards, diffs) so we measure each turn as it renders/grows.
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 140,
    getItemKey: (i) => itemKeys[i]!,
    overscan: 6
  })
  const virtualItems = virtualizer.getVirtualItems()
  const viewport = scrollRef.current
  const activeVirtualItem = viewport && virtualItems.length > 0
    ? viewport.scrollTop <= 56
      ? virtualItems[0]
      : viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 56
        ? virtualItems.at(-1)
        : virtualItems.reduce((nearest, item) =>
            Math.abs(item.start + item.size / 2 - viewport.scrollTop - viewport.clientHeight / 2) <
            Math.abs(nearest.start + nearest.size / 2 - viewport.scrollTop - viewport.clientHeight / 2)
              ? item
              : nearest
          )
    : virtualItems[0]
  const activeRailId = activeVirtualItem ? itemKeys[activeVirtualItem.index] : itemKeys[0]

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
    const el = scrollRef.current
    if (el) restoreScroll.current = { height: el.scrollHeight, top: el.scrollTop }
    // Never let live-edge following yank the reader back down mid-prepend.
    setFollowing(false)
    onLoadEarlier?.()
  }, [onLoadEarlier])

  // Runs on the same `messages` change as the prepend. Following is paused, so
  // an errored load prepends nothing and equal heights make this a no-op.
  useLayoutEffect(() => {
    const el = scrollRef.current
    const saved = restoreScroll.current
    if (!el || !saved) return
    el.scrollTop = el.scrollHeight - saved.height + saved.top
    restoreScroll.current = null
  }, [messages])

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
          followOutput={following}
          onFollowChange={setFollowing}
          busy={busy}
          viewportRef={scrollRef}
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
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${item.start}px)` }}
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
        <div className={cn("flex-none pb-[18px] pt-[11px]", gutter)}>
          <div className="mx-auto w-full max-w-[760px]">
            {/* Live session analytics — elapsed time + current context size, right
              above the composer so it stays visible while the user works. */}
          {!archived && (busy || runStartedAt !== null || tokens > 0) && (
            <div className="mb-1.5 flex min-w-0 flex-wrap items-center justify-end gap-x-2.5 gap-y-1">
              <ContextMeter
                tokens={tokens}
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
          )}
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
                  {queued.slice(0, queueLimit).map((item) => {
                    // In flight: the row still shows (nothing is confirmed yet) but
                    // every action is withheld, because the agent already has this
                    // text and acting on it would run the prompt a second time.
                    const sending = item.id === steeringId
                    return (
                      <QueuedMessageRow
                        key={item.id}
                        text={item.text}
                        images={item.images.length}
                        handoffHint={handoffHint}
                        sending={sending}
                        {...(onSendNow && busy && !sending
                          ? { onSendNow: () => onSendNow(item.id) }
                          : {})}
                        {...(onHandoffQueued && !sending
                          ? { onHandoff: () => onHandoffQueued(item.id) }
                          : {})}
                        {...(onEditQueued && !sending
                          ? { onEdit: (text: string) => onEditQueued(item.id, text) }
                          : {})}
                        {...(onUnqueue && !sending ? { onRemove: () => onUnqueue(item.id) } : {})}
                      />
                    )
                  })}
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
                connectionId={connectionId}
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
        </div>
      </div>
    </div>
  )
}
