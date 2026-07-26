/**
 * Bridges the renderer's conversation machine to the presentational
 * `ConversationView` / `PlanReview`. Mounted keyed by session id (see
 * `StarbaseApp`), so each session drives its own machine instance. The machine
 * lives here — above the Conversation ↔ Plan Review view switch — so switching to
 * the Plan tab does NOT unmount the agent stream (which would abort a parked plan).
 */
import { useCallback, useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import type { Session } from "@starbase/core"
import { agentChildren, agentPath } from "@starbase/core"
import {
  OpenAssetProvider,
  SubagentTabBar,
  BackgroundTaskDock,
  BackgroundTaskOutput,
  ConversationView,
  MAIN_AGENT,
  PlanReview,
  ResizeHandle,
  SubagentView,
  useResizableWidth
} from "@starbase/ui"
import { rpc } from "./rpc-client.js"
import { publishSessionUpdate } from "./session-updates.js"
import {
  disposeChatActor,
  getConversationActor,
  rehomeSharedPlan
} from "./conversation-registry.js"
import { clearDraft, getDraft, seedDraftOnce, setDraft, useDraft } from "./draft-store.js"
import { useConversation } from "./use-conversation.js"
import { useBackgroundTasks } from "./use-background-tasks.js"

export function ConversationPane({
  session,
  view = "conversation",
  onOpenPlanReview,
  planStepId,
  onPlanStepSelected,
  onRestore,
  onDelete,
  onInitialPromptConsumed,
  onOpenAsset,
  paneFocused = true
}: {
  session: Session
  /**
   * Which face of the session to show: the transcript, the Plan Review, or both
   * side by side. `split` renders the SAME Plan Review beside the transcript
   * rather than a condensed rail — one conversation machine, two columns, so
   * toggling it can never remount (and so never abort) a live run.
   */
  view?: "conversation" | "plan" | "split"
  /**
   * Switch the pane to the Plan Review view — bare from the inline plan card, or
   * with a step id from the Conversation progress rail (a deep link).
   */
  onOpenPlanReview?: (stepId?: string) => void
  /** The step Plan Review should open at (a pending deep link from the rail). */
  planStepId?: string | null
  /** Plan Review's selection moved — lets the host retire a spent deep link. */
  onPlanStepSelected?: () => void
  /** Restore this session from archived (the banner + locked composer). */
  onRestore?: (sessionId: string) => void
  /** Permanently delete this session (the banner). */
  onDelete?: (sessionId: string) => void
  /** Notify once the composer has consumed the one-shot initial prompt. */
  onInitialPromptConsumed?: (sessionId: string) => void
  /**
   * Open a worktree file in the Preview dock. Supplied by the app; when it is
   * absent every path in the transcript stays inert text, which is exactly what
   * Storybook and the component tests want.
   */
  onOpenAsset?: (sessionId: string, path: string) => void
  /**
   * Whether this is the pane the operator is looking at. Only that pane's
   * composer takes the caret when the conversation opens.
   */
  paneFocused?: boolean
}) {
  const activeChat =
    session.chats.find((chat) => chat.id === session.activeChatId) ??
    session.chats[0]!
  const convo = useConversation(session, activeChat.id)

  // Everything the transcript needs to turn a path into a link. `convo.files` is
  // the worktree's tracked-file list, already fetched for the composer's `@`
  // menu — reusing it is what keeps the false-positive gate free.
  const knownFiles = useMemo(() => new Set(convo.files), [convo.files])
  const openAsset = useCallback(
    (path: string) => onOpenAsset?.(session.id, path),
    [onOpenAsset, session.id]
  )

  // Declared unconditionally (hook order) — the plan column only reads it in the
  // `split` view, but the `plan` view returns early above.
  const planSplit = useResizableWidth({ storageKey: "sb.split.plan", initial: 520, min: 360, max: 900 })

  // Background tasks. Gated on the HARNESS's capability, read from discovery —
  // only Claude reports a live task set and accepts a per-task stop, so the dock
  // stays hidden elsewhere rather than offering a button with nothing to aim at.
  const clisQuery = useQuery({ queryKey: ["clis"], queryFn: () => rpc.discoveryList() })
  /**
   * The model a handed-off message runs on: the operator's own default for this
   * harness (Settings · Providers), NOT this chat's pinned model — the point of
   * handing off is to escape this chat's setup. Null when they've never set one,
   * which means "leave the new chat on whatever it starts with".
   */
  const providersQuery = useQuery({ queryKey: ["config"], queryFn: () => rpc.configGet() })
  const handoffModel = providersQuery.data?.providers?.[convo.cli]?.defaultModel ?? null
  const backgroundTasksSupported =
    clisQuery.data?.find((c) => c.kind === convo.cli)?.backgroundTasks ?? false
  const bgTasks = useBackgroundTasks(session.id, backgroundTasksSupported)

  /**
   * Context accounting for the meter.
   *
   * Re-read when the live token count changes rather than polled: `convo.tokens`
   * moves on every `Usage` event, so keying the query on it gives a meter that
   * tracks the run without a timer running against every open session. Gated on
   * the harness reporting context at all — the meter renders nothing when
   * `triggerAt` is null, and asking for a snapshot we would not draw is waste.
   */
  const contextReporting =
    clisQuery.data?.find((c) => c.kind === convo.cli)?.contextReporting ?? false
  /**
   * The session's context accounting.
   *
   * NOT keyed on the live token count. Keying it there seemed natural — refetch
   * whenever usage moves — but every `Usage` event then produced a new cache
   * entry whose `data` starts `undefined`, so `triggerAt` went null and the
   * meter UNMOUNTED. Mid-run, where usage updates constantly, it could never
   * appear at all. It also fired one RPC per token update. The live number comes
   * from `convo.tokens` instead.
   *
   * It IS keyed on the harness and model, because the trigger point is derived
   * from them: a session switched from Claude to Codex has a different window
   * and therefore a different budget. Keyed on the session alone, the meter and
   * the Compact now action would keep pointing at the old harness's numbers —
   * and because a disabled query still serves its last data, switching to a
   * harness that reports nothing (Cursor) would leave the previous harness's
   * meter on screen rather than hiding it.
   */
  const [requested, setRequested] = useState(false)
  const contextQuery = useQuery({
    queryKey: ["context", session.id, activeChat.id, convo.cli, convo.model],
    queryFn: () => rpc.contextState(session.id, activeChat.id),
    enabled: contextReporting,
    /**
     * Poll while a compaction could be happening.
     *
     * The digest runs on a background fiber with no push channel to the
     * renderer, so polling is the only way to see it start or finish. Scoped to
     * when something might actually be in flight — a session sitting well inside
     * its budget needs no timer.
     */
    refetchInterval: (query) =>
      requested || query.state.data?.preparing || convo.busy ? 1500 : false
  })
  const preparing = contextQuery.data?.preparing ?? false
  const digestReady = contextQuery.data?.digestReady ?? false
  // The manual request is only needed until the manager reports the fiber it
  // started; after that `preparing` is the authoritative signal.
  useEffect(() => {
    if (preparing || digestReady) setRequested(false)
  }, [preparing, digestReady])
  // A turn crossing the budget starts a digest, so re-read once it settles.
  useEffect(() => {
    if (!convo.busy && contextReporting) void contextQuery.refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convo.busy, contextReporting])
  const [viewingTaskId, setViewingTaskId] = useState<string | null>(null)
  const [taskOutput, setTaskOutput] = useState("")
  const viewingTask = bgTasks.tasks.find((t) => t.id === viewingTaskId) ?? null

  // The composer's draft lives in the store, not the composer — this pane is
  // mounted keyed by session id, so switching sessions unmounts it and any local
  // state goes with it. See `draft-store`.
  const draft = useDraft(activeChat.id)

  // The prefilled task is one-shot, but we clear it (backend + app state) only
  // once the user actually SENDS — not on mount. Clearing on mount lost the draft
  // when the user visited the Issue tab first (that unmounts this pane, discarding
  // the composer's seeded text; on return `initialPrompt` was already gone).
  // Consuming on send keeps the seed alive across those unmounts until it's used.
  // It now seeds the DRAFT STORE (once ever, never over existing text), so the
  // prefill survives the same unmounts the store was built for.
  useEffect(() => {
    if (session.initialPrompt) {
      seedDraftOnce(activeChat.id, session.initialPrompt, session.id)
    }
  }, [activeChat.id, session.id, session.initialPrompt])

  const sendPrompt: typeof convo.sendPrompt = (...args) => {
    if (session.initialPrompt) onInitialPromptConsumed?.(session.id)
    // The turn is on its way to the agent — the draft has served its purpose.
    clearDraft(activeChat.id)
    if (activeChat.title === null && args[0].trim()) {
      const title = args[0].trim().split("\n")[0]!.slice(0, 48)
      void rpc
        .sessionsRenameChat(session.id, activeChat.id, title)
        .then(publishSessionUpdate)
    }
    return convo.sendPrompt(...args)
  }

  const createChat = () => {
    void rpc.sessionsCreateChat(session.id).then(publishSessionUpdate)
  }

  /**
   * Hand a queued message to a FRESH chat instead of this one.
   *
   * The queue's other actions all answer "when should this run here?"; this one
   * answers "this shouldn't run here at all". A follow-up that is really its own
   * job would otherwise inherit the whole of this conversation's context (and
   * whatever model this chat was pinned to), so hand-off starts a clean chat in
   * the SAME worktree, on the operator's configured default model, and sends the
   * message there.
   *
   * The message leaves this queue LAST, in the same tick as the send to the new
   * chat. Unqueuing first read as the safer order — no window where the same
   * prompt sits in two places — but the window it opened was worse: a failed
   * `createChat` left the operator's text deleted with nothing on screen to say
   * so. Nothing is dropped until there is somewhere for it to land.
   */
  const handoffQueued = (id: string) => {
    if (!convo.queued.some((queued) => queued.id === id)) return
    void rpc
      .sessionsCreateChat(session.id)
      .then((updated) => {
        // Re-read the queue: creating the chat took a round trip, and the running
        // turn's next tool boundary may have handed this very message to the agent
        // in the meantime. Handing it off as well would run it twice.
        const item = convo.queued.find((queued) => queued.id === id)
        publishSessionUpdate(updated)
        if (item === undefined) return
        const actor = getConversationActor(updated, updated.activeChatId)
        // `createChat` activates the new chat, so this is the chat the operator is
        // now looking at. Put it on the default model before the send, so the very
        // first turn runs on the intended harness rather than switching under it.
        if (handoffModel !== null && handoffModel !== convo.model) {
          actor.send({ type: "SET_HARNESS", cli: convo.cli, model: handoffModel })
        }
        actor.send({ type: "SEND", text: item.text, images: item.images })
        convo.unqueue(id)
      })
      // The chat was never created, so the message is still queued exactly where
      // the operator left it — the hand-off simply didn't happen. Swallowing the
      // rejection is deliberate: there is nothing to recover, and an unhandled
      // one would surface as a console error for a no-op.
      .catch(() => {})
  }
  const selectChat = (chatId: string) => {
    if (chatId === activeChat.id) return
    void rpc.sessionsSelectChat(session.id, chatId).then(publishSessionUpdate)
  }
  const closeChat = (chatId: string) => {
    void rpc.sessionsCloseChat(session.id, chatId).then((updated) => {
      clearDraft(chatId)
      rehomeSharedPlan(session.id, chatId, updated.activeChatId)
      disposeChatActor(session.id, chatId)
      publishSessionUpdate(updated)
    }).catch(() => {})
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((!event.metaKey && !event.ctrlKey) || event.altKey) return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      ) return
      if (event.key.toLowerCase() === "t") {
        event.preventDefault()
        createChat()
        return
      }
      if (event.key.toLowerCase() === "w") {
        event.preventDefault()
        closeChat(activeChat.id)
        return
      }
      const index = Number(event.key) - 1
      if (index >= 0 && index < Math.min(session.chats.length, 9)) {
        event.preventDefault()
        selectChat(session.chats[index]!.id)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [session.id, session.chats, activeChat.id])

  // Which sub-agent tab is selected ("main" = the parent conversation). Declared
  // before the Plan Review early-return so hook order stays stable. We derive the
  // effective selection so a finished (auto-removed) sub-agent falls back to Main
  // without an effect — its tab and view disappear together.
  const [selectedAgent, setSelectedAgent] = useState<string>(MAIN_AGENT)
  // The reviewer sits in the same bar as the turn's sub-agents but is not one of
  // them (it is a whole agent run of its own, started by the PR tab or the
  // background auto-review), so it is appended here rather than living in the list.
  const agents = convo.reviewer ? [...convo.subagents, convo.reviewer] : convo.subagents
  const activeSubagent = agents.find((s) => s.id === selectedAgent) ?? null
  const activeAgent = activeSubagent ? selectedAgent : MAIN_AGENT

  // Sub-agents nest, so the bar shows one level at a time: `level` is the agent
  // whose children are listed (MAIN_AGENT = the top level). Derived the same way
  // as the selection — if the drilled-into agent is gone (the list resets on the
  // next run) we fall back to the top level rather than stranding an empty bar.
  const [level, setLevel] = useState<string>(MAIN_AGENT)
  const effectiveLevel =
    level !== MAIN_AGENT && convo.subagents.some((s) => s.id === level) ? level : MAIN_AGENT
  const levelAgents = agentChildren(
    convo.subagents,
    effectiveLevel === MAIN_AGENT ? null : effectiveLevel
  )
  // The reviewer is a top-level agent of its own — a whole run started by the PR
  // tab or the background auto-review, not a `Task` spawn — so it joins the top
  // level of the bar, but never the children of a sub-agent drilled into.
  const barAgents =
    effectiveLevel === MAIN_AGENT && convo.reviewer
      ? [...levelAgents, convo.reviewer]
      : levelAgents
  const trail =
    effectiveLevel === MAIN_AGENT
      ? []
      : agentPath(convo.subagents, effectiveLevel).map((s) => ({ id: s.id, name: s.name }))

  // Drilling into an agent shows its children AND its own transcript; a crumb
  // jumps the level back up. Both keep the two states in step.
  const goToAgent = (id: string) => {
    setLevel(id)
    setSelectedAgent(id)
  }
  const goToMain = () => {
    setLevel(MAIN_AGENT)
    setSelectedAgent(MAIN_AGENT)
  }

  // Live agent status + Plan-tab presence are published by the conversation
  // registry (from the actor's own subscription), so they stay correct even
  // while this pane is unmounted for a background session. Nothing to do here.

  const planId = convo.plan?.id ?? null

  const planReview = (
    <PlanReview
      plan={convo.plan}
      compact={view === "split"}
      patch={convo.patch}
      selectedStepId={planStepId}
      onSelectStep={onPlanStepSelected}
      onApprove={(executionMode) => planId && convo.approvePlan(planId, executionMode)}
      onResume={() => planId && convo.resumePlan(planId)}
      onRevise={() => planId && convo.revisePlan(planId)}
      onComment={(stepId, body) => planId && convo.commentPlanStep(planId, stepId, body)}
    />
  )

  if (view === "plan") {
    return (
      <OpenAssetProvider
        open={openAsset}
        knownFiles={knownFiles}
        worktreeRoot={session.worktreePath}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          {planReview}
        </div>
      </OpenAssetProvider>
    )
  }

  // Directly beneath the main tab bar, a secondary bar surfaces the turn's live
  // sub-agents (only while some exist). Selecting one swaps the pane to its
  // watch-only transcript; "Main" shows the conversation. The stream keeps running
  // either way — the actor lives in the registry, not this pane, so swapping the
  // view never aborts the run.
  return (
    <OpenAssetProvider
        open={openAsset}
        knownFiles={knownFiles}
        worktreeRoot={session.worktreePath}
      >
    {/* `min-w-0` is load-bearing on BOTH rows, not decoration. A flex item
        defaults to `min-width: auto`, which refuses to shrink below its content —
        so a wide child (the sub-agent tab strip, whose cells are `flex-none` and
        `whitespace-nowrap`) pushes this row past the viewport instead of letting
        the strip's own `overflow-x-auto` take over. The inner column already had
        it; this outer row did not, so the constraint stopped one level short. */}
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {barAgents.length > 0 && (
        <SubagentTabBar
          agents={barAgents.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            status: s.status,
            hasChildren: convo.subagents.some((c) => c.parentId === s.id)
          }))}
          trail={trail}
          active={activeAgent}
          onChange={setSelectedAgent}
          onDrill={goToAgent}
          onNavigate={(id) => (id === MAIN_AGENT ? goToMain() : goToAgent(id))}
        />
      )}
      {activeSubagent ? (
        <SubagentView subagent={activeSubagent} cli={convo.cli} />
      ) : (
        <ConversationView
          messages={convo.messages}
          mode={convo.mode}
          cli={convo.cli}
          skills={convo.skills}
          files={convo.files}
          paused={convo.paused}
          branch={session.branch}
          busy={convo.busy}
          tokens={convo.tokens}
          contextTriggerAt={contextQuery.data?.triggerAt ?? null}
          contextPhase={contextQuery.data?.phase ?? "unknown"}
          contextPreparing={preparing || requested}
          contextDigestReady={digestReady}
          contextStalled={contextQuery.data?.stalled ?? false}
          contextHeld={contextQuery.data?.held ?? false}
          contextHeldReason={contextQuery.data?.heldReason ?? null}
          onCompactNow={() => {
            setRequested(true)
            void rpc
              .contextCompactNow(session.id, activeChat.id)
              .catch(() => setRequested(false))
          }}
          runStartedAt={convo.runStartedAt}
          queued={convo.queued}
          onUnqueue={convo.unqueue}
          onSendNow={convo.sendNow}
          onEditQueued={convo.editQueued}
          onHandoffQueued={handoffQueued}
          steeringId={convo.steeringId}
          handoffHint={
            handoffModel
              ? `Hand off — run this in a new chat on ${handoffModel}`
              : "Hand off — run this in a new chat"
          }
          model={convo.model}
          catalog={convo.catalog}
          onSetHarness={convo.setHarness}
          onSend={sendPrompt}
          onStop={convo.stop}
          onDecideGate={convo.decideGate}
          onSetMode={convo.setMode}
          reasoningEffort={convo.reasoning?.effort}
          thinkingEnabled={convo.reasoning?.enabled}
          onSetReasoning={convo.setReasoning}
          adversarialPlanning={convo.adversarialPlanning ?? undefined}
          onHandoffPlan={convo.handoffPlan}
          question={convo.question}
          onAnswerQuestion={convo.answerQuestion}
          onApprovePlan={(id) => convo.approvePlan(id)}
          onResumePlan={(id) => convo.resumePlan(id)}
          onOpenPlanReview={onOpenPlanReview}
          plan={convo.plan}
          draft={draft.text}
          // Merge against the LIVE draft, never the render-time `draft` closure:
          // on send the composer fires onSend → setValue("") → setAttachments([])
          // in one go, so a stale spread would resurrect the text it just sent.
          onDraftChange={(text) =>
            setDraft(activeChat.id, { ...getDraft(activeChat.id), text })
          }
          draftAttachments={draft.attachments}
          onDraftAttachmentsChange={(attachments) =>
            setDraft(activeChat.id, { ...getDraft(activeChat.id), attachments })
          }
          // The Plan face returns early above, so reaching here already means the
          // transcript is on screen — only the focused pane still has to be checked.
          autoFocusComposer={paneFocused}
          focusKey={activeChat.id}
          archived={
            session.archived
              ? {
                  reason: session.archiveReason ?? "merged",
                  prNumber: session.prNumber,
                  base: session.baseBranch,
                  onRestore: () => onRestore?.(session.id),
                  onDelete: () => onDelete?.(session.id)
                }
              : undefined
          }
        />
      )}
      {/*
        Background tasks dock — harness work that OUTLIVES this turn. Sits below
        the conversation (not in the sub-agent tab bar, which is per-run and
        cleared on the next turn) so a task the operator needs to stop can't be
        swept away while it is still running. Renders nothing when the harness
        has no per-task support or there is nothing to show.
      */}
      {viewingTask && (
        <BackgroundTaskOutput
          task={viewingTask}
          output={taskOutput}
          onClose={() => setViewingTaskId(null)}
        />
      )}
      <BackgroundTaskDock
        tasks={bgTasks.tasks}
        supported={backgroundTasksSupported}
        onStop={bgTasks.stop}
        onDismiss={bgTasks.dismiss}
        onView={(taskId) => {
          setViewingTaskId(taskId)
          void bgTasks.output(taskId).then(setTaskOutput)
        }}
      />
      </div>

      {/*
        Split view: the real Plan Review beside the transcript. This replaced a
        narrow step-progress rail, which could only ever be a lossy restatement of
        this screen in a column too small to act on. Kept OUTSIDE the transcript's
        scrolling column so the virtualizer measures against a stable width.
      */}
      {view === "split" && (
        <>
          <ResizeHandle aria-label="Resize plan" onResize={(dx) => planSplit.adjust(-dx)} />
          <div
            style={{ width: planSplit.width }}
            className="flex min-h-0 flex-none flex-col overflow-hidden border-l border-hairline"
          >
            {planReview}
          </div>
        </>
      )}
    </div>
    </OpenAssetProvider>
  )
}
