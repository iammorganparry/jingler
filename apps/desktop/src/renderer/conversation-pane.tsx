/**
 * Bridges the renderer's conversation machine to the presentational
 * `ConversationView` / `PlanReview`. Mounted keyed by session id (see
 * `JinglerApp`), so each session drives its own machine instance. The machine
 * lives here — above the Conversation ↔ Plan Review view switch — so switching to
 * the Plan tab does NOT unmount the agent stream (which would abort a parked plan).
 */
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import type { Session } from "@jingler/core"
import { agentChildren, agentPath, clampFontScale } from "@jingler/core"
import {
  AttachmentSourceProvider,
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
} from "@jingler/ui"
import { rpc } from "./rpc-client.js"
import { publishSessionUpdate } from "./session-updates.js"
import {
  disposeChatActor,
  getConversationActor,
  rehomeSharedPlan
} from "./conversation-registry.js"
import { clearDraft, getDraft, seedDraftOnce, setDraft, useDraft } from "./draft-store.js"
import { useConversation } from "./use-conversation.js"
import { usePlanDocument } from "./use-plan-document.js"
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
   * with a stage id from the composer progress dock (a deep link).
   */
  onOpenPlanReview?: (stepId?: string) => void
  /** The stage Plan Review should open at (a pending deep link from the dock). */
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
  const canonicalPlan = usePlanDocument(session.id)

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
  // Conversation text-size multiplier, scoped to the transcript wrapper below via
  // a `--sb-font-scale` CSS var. Set HERE rather than on document.documentElement
  // on purpose: the shared `.sb-md` calc() rules must only scale inside the
  // conversation, never a PR description, plan or asset preview — which render the
  // same markdown but stay put, per the setting's stated scope. Elements outside
  // this wrapper never see the var, so their calc() falls back to 1×.
  const fontScale = clampFontScale(providersQuery.data?.fontScale)
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
  /**
   * Fetch one transcript image's bytes. `Sessions.transcript` leaves them out —
   * they are 80% of a transcript's weight — so a thumbnail asks for them when it
   * mounts, which in a virtualized list means the few on screen.
   *
   * Keyed on the chat, not the session: attachments live in the chat's own
   * transcript file, and two chats in one session have separate ones.
   */
  const resolveAttachment = useCallback(
    (attachmentId: string) => rpc.sessionsAttachment(activeChat.id, attachmentId),
    [activeChat.id]
  )

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

  const planId = canonicalPlan.document?.id ?? convo.plan?.id ?? null

  const planReview = (
    <PlanReview
      plan={convo.plan}
      document={canonicalPlan.document}
      draft={canonicalPlan.draft}
      remote={canonicalPlan.remote}
      syncState={canonicalPlan.state}
      syncError={canonicalPlan.error ?? convo.planActionError}
      canApprove={canonicalPlan.canApprove}
      compact={view === "split"}
      patch={convo.patch}
      selectedStepId={planStepId}
      onSelectStep={onPlanStepSelected}
      onApprove={(executionMode) =>
        planId &&
        convo.approvePlan(planId, executionMode, canonicalPlan.document?.revision)
      }
      onResume={() =>
        planId && convo.resumePlan(planId, canonicalPlan.document?.revision)
      }
      onRevise={() => planId && convo.revisePlan(planId)}
      onComment={(stepId, body) => planId && convo.commentPlanStep(planId, stepId, body)}
      onStartDraft={canonicalPlan.startDraft}
      onSendToAgent={() => {
        // Hand the user-authored draft to the agent as a plan-mode turn: switch
        // into plan mode and send the draft MDX as the starting point. The agent
        // proposes a refined plan, which replaces the draft as the canonical doc.
        const source = canonicalPlan.draft ?? canonicalPlan.document?.source ?? ""
        convo.setMode("plan")
        convo.sendPrompt(
          [
            "I've drafted the plan below. Treat it as the starting point:",
            "review it, fill in the gaps, and propose a complete plan.",
            "",
            "````html plan",
            source.trim(),
            "````"
          ].join("\n")
        )
      }}
      onEditDocument={canonicalPlan.edit}
      onSaveDocument={canonicalPlan.save}
      onRetryDocument={canonicalPlan.retry}
      onKeepLocal={canonicalPlan.keepLocal}
      onAcceptRemote={canonicalPlan.acceptRemote}
      onStopWorker={(agentId) => {
        if (planId) void rpc.agentStopWorker(session.id, planId, agentId)
      }}
      onRetryWorker={(agentId) => {
        if (planId) void rpc.agentRetryWorker(session.id, planId, agentId)
      }}
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
    <AttachmentSourceProvider resolve={resolveAttachment}>
    {/* `min-w-0` is load-bearing on BOTH rows, not decoration. A flex item
        defaults to `min-width: auto`, which refuses to shrink below its content —
        so a wide child (the sub-agent tab strip, whose cells are `flex-none` and
        `whitespace-nowrap`) pushes this row past the viewport instead of letting
        the strip's own `overflow-x-auto` take over. The inner column already had
        it; this outer row did not, so the constraint stopped one level short. */}
    <div className="flex min-h-0 min-w-0 flex-1" style={{ "--sb-font-scale": fontScale } as CSSProperties}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {barAgents.length > 0 && (
        <SubagentTabBar
          agents={barAgents.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            status: s.status,
            hasChildren: convo.subagents.some((c) => c.parentId === s.id),
            // The reviewer is not a harness sub-agent — see `closable`.
            closable: s.id !== convo.reviewer?.id
          }))}
          trail={trail}
          active={activeAgent}
          onChange={setSelectedAgent}
          onDrill={goToAgent}
          onNavigate={(id) => (id === MAIN_AGENT ? goToMain() : goToAgent(id))}
          onStop={convo.stopSubagent}
          onClose={(id) => {
            // Back to Main FIRST. Both the transcript being read and the level
            // being browsed can point at the tab about to vanish (or at one of
            // its children, which go with it), and a pane left pointing at a
            // retracted id renders an empty transcript with no way back.
            if (activeAgent === id || effectiveLevel === id) goToMain()
            convo.closeSubagent(id)
          }}
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
          repo={session.repo}
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
          question={convo.question}
          onAnswerQuestion={convo.answerQuestion}
          onApprovePlan={
            canonicalPlan.canApprove && canonicalPlan.document !== null
              ? (id, executionMode) =>
                  convo.approvePlan(id, executionMode, canonicalPlan.document?.revision)
              : undefined
          }
          onResumePlan={
            canonicalPlan.canApprove && canonicalPlan.document !== null
              ? (id) => convo.resumePlan(id, canonicalPlan.document?.revision)
              : undefined
          }
          onOpenPlanReview={onOpenPlanReview}
          plan={convo.plan}
          planDocument={canonicalPlan.document}
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
        Split view: the real Plan Review beside the transcript. The composer dock
        remains a compact status summary; this is the complete editable source of
        truth. Kept OUTSIDE the transcript's scrolling column so the virtualizer
        measures against a stable width.
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
    </AttachmentSourceProvider>
    </OpenAssetProvider>
  )
}
