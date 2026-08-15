/**
 * Bridges the renderer's conversation machine to the presentational
 * `ConversationView` / `PlanReview`. Mounted keyed by session id (see
 * `JinglerApp`), so each session drives its own machine instance. The machine
 * lives here — above the Conversation ↔ Plan Review view switch — so switching to
 * the Plan tab does NOT unmount the agent stream (which would abort a parked plan).
 */
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import type {
  Environment,
  ProviderCatalog,
  Session
} from "@jingler/core"
import { clampFontScale } from "@jingler/core"
import {
  AttachmentSourceProvider,
  OpenAssetProvider,
  BackgroundTaskDock,
  BackgroundTaskOutput,
  ConversationView,
  FleetAgentView,
  FleetDrawer,
  PlanReview,
  ResizeHandle,
  RuntimeRecoveryCard,
  useContainerWidth
} from "@jingler/ui"
import { rpc } from "./rpc-client.js"
import { publishSessionUpdate } from "./session-updates.js"
import {
  disposeChatActor,
  getConversationActor,
  rehomeSharedPlan
} from "./conversation-registry.js"
import { clearDraft, getDraft, seedDraftOnce, setDraft, useDraft } from "./draft-store.js"
import { takeFirstMessage } from "./first-message-store.js"
import {
  codeReferenceDisplayLabel,
  serializeCodeReferences
} from "./code-reference.js"
import { useConversation } from "./use-conversation.js"
import { MAIN_FLEET_AGENT, useSubagentFleet } from "./use-subagent-fleet.js"
import { usePlanDocument } from "./use-plan-document.js"
import { matchesCanonicalPlan } from "./plan-document-machine.js"
import {
  runWithDirectPlanThreadDispatch,
  shouldRecoverPendingPlanMessage
} from "./plan-thread-dispatch.js"
import { useBackgroundTasks } from "./use-background-tasks.js"
import { useFileBrowser } from "./use-file-browser.js"
import {
  clampedPlanSplitRatio,
  DEFAULT_PLAN_SPLIT_RATIO,
  PLAN_SPLIT_HANDLE_WIDTH,
  resizedPlanSplitRatio
} from "./plan-split-ratio.js"
import { claimPlanAutoPresentation } from "./plan-presence.js"
import {
  rpcFailureMessage,
  rpcFailureNumber,
  rpcFailureReason,
  rpcFailureTag
} from "./rpc-failure.js"
import { providerRecoveryOf } from "./provider-recovery.js"

const PLAN_SPLIT_RATIO_KEY = "sb.split.plan.ratio"

const initialPlanSplitRatio = (): number => {
  try {
    const stored = Number(localStorage.getItem(PLAN_SPLIT_RATIO_KEY))
    return Number.isFinite(stored) && stored > 0 && stored < 1
      ? stored
      : DEFAULT_PLAN_SPLIT_RATIO
  } catch {
    return DEFAULT_PLAN_SPLIT_RATIO
  }
}

export function ConversationPane({
  session,
  view = "conversation",
  onOpenPlanReview,
  onPlanDraftAvailable,
  planStepId,
  onPlanStepSelected,
  onRestore,
  onDelete,
  onInitialPromptConsumed,
  onOpenFile,
  environments,
  providerCatalog,
  onSelectFiles,
  onSelectChanges,
  onOpenProviderSettings,
  paneFocused = true
}: {
  session: Session
  /** Live paired-device catalogue owned by the app-level environment controller. */
  environments: ReadonlyArray<Environment>
  /** Certified provider connections available on this execution target. */
  providerCatalog?: ProviderCatalog | null
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
  /** Auto-present the first renderable plan draft at the host's responsive width. */
  onPlanDraftAvailable?: () => void
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
   * Open a worktree file in the session's Files tab. Supplied by the app; when it is
   * absent every path in the transcript stays inert text, which is exactly what
   * Storybook and the component tests want.
   */
  onOpenFile?: (sessionId: string, path: string) => void
  /** Present Files beside the conversation when follow mode is enabled here. */
  onSelectFiles?: () => void
  /** Open the canonical Changes view from uncertain-mutation recovery. */
  onSelectChanges?: () => void
  /** Open provider settings for auth, target, migration, or certification recovery. */
  onOpenProviderSettings?: () => void
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
  const [continuationEnvironmentId, setContinuationEnvironmentId] = useState<
    string | undefined | null
  >(null)
  const [handoffAfterStop, setHandoffAfterStop] = useState<{
    environmentId: string | undefined
  } | null>(null)
  const continueEnvironmentMutation = useMutation({
    mutationFn: (environmentId?: string) =>
      rpc.sessionsContinueOnEnvironment(session.id, environmentId),
    onSuccess: (continued) => {
      setContinuationEnvironmentId(null)
      setHandoffAfterStop(null)
      publishSessionUpdate(continued)
    }
  })
  const environmentMutation = useMutation({
    mutationFn: (environmentId?: string) =>
      rpc.sessionsSetEnvironment(session.id, environmentId),
    onSuccess: publishSessionUpdate,
    onError: (error, environmentId) => {
      if (
        rpcFailureTag(error) === "EnvironmentHandoffError" &&
        rpcFailureReason(error) === "has-work"
      ) {
        setContinuationEnvironmentId(environmentId)
      }
    }
  })
  useEffect(() => {
    if (handoffAfterStop === null || convo.busy) return
    const { environmentId } = handoffAfterStop
    setHandoffAfterStop(null)
    continueEnvironmentMutation.mutate(environmentId)
  }, [convo.busy, handoffAfterStop, continueEnvironmentMutation.mutate])
  const fileBrowser = useFileBrowser(session.id, session.worktreePath)
  const toggleFollowAgent = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        fileBrowser.enableFollow()
        onSelectFiles?.()
      } else {
        fileBrowser.disableFollow()
      }
    },
    [fileBrowser.disableFollow, fileBrowser.enableFollow, onSelectFiles]
  )
  const handledPlanDraftPresentation = useRef(0)
  useEffect(() => {
    if (
      convo.planDraftPresentationNonce === 0 ||
      convo.planDraftPresentationNonce <= handledPlanDraftPresentation.current
    ) {
      return
    }
    handledPlanDraftPresentation.current = convo.planDraftPresentationNonce
    if (
      onPlanDraftAvailable !== undefined &&
      claimPlanAutoPresentation(session.id)
    ) {
      onPlanDraftAvailable()
    }
  }, [convo.planDraftPresentationNonce, onPlanDraftAvailable, session.id])
  const canonicalPlan = usePlanDocument(session.id)
  const canApprovePlan =
    canonicalPlan.canApprove &&
    matchesCanonicalPlan(canonicalPlan.document, convo.plan)
  const initialThreadDispatches = useRef(new Set<string>())
  // A direct reply RPC persists its pending message before it finishes routing.
  // Plan.watch can publish that intermediate revision, so tell the recovery
  // effect which thread already has a dispatcher. Threads accept one pending
  // reply at a time, making the annotation id the correct local lease key.
  useEffect(() => {
    const document = canonicalPlan.document
    if (document === null) return
    const pending = document.plan.annotations
      .flatMap((annotation) =>
        annotation.messages.map((message) => ({ annotation, message }))
      )
      .find(
        ({ annotation, message }) =>
          shouldRecoverPendingPlanMessage({
            planId: document.id,
            annotationId: annotation.id,
            message,
            recoveredMessageDispatches: initialThreadDispatches.current
          })
      )
    if (pending === undefined) return
    const key = `${document.id}:${pending.message.id}`
    initialThreadDispatches.current.add(key)
    void rpc
      .planDispatchExistingMessage({
        sessionId: session.id,
        planId: document.id,
        baseRevision: document.revision,
        annotationId: pending.annotation.id,
        messageId: pending.message.id
      })
      .catch(async () => {
        initialThreadDispatches.current.delete(key)
        const latest = await rpc.planCurrent(session.id).catch(() => null)
        const stillPending = latest?.plan.annotations
          .find((annotation) => annotation.id === pending.annotation.id)
          ?.messages.find((message) => message.id === pending.message.id)
        if (latest === null || stillPending?.deliveryState !== "pending") return
        await rpc
          .planUpdateMessageDelivery({
            sessionId: session.id,
            planId: latest.id,
            baseRevision: latest.revision,
            annotationId: pending.annotation.id,
            messageId: pending.message.id,
            deliveryState: "failed",
            author: "user"
          })
          .catch(() => {})
      })
  }, [canonicalPlan.document, session.id])

  // Everything the transcript needs to turn a path into a link. `convo.files` is
  // the worktree's tracked-file list, already fetched for the composer's `@`
  // menu — reusing it is what keeps the false-positive gate free.
  const knownFiles = useMemo(() => new Set(convo.files), [convo.files])
  const openAsset = useCallback(
    (path: string) => onOpenFile?.(session.id, path),
    [onOpenFile, session.id]
  )

  // A ratio, not a fixed plan width: the first split gives Plan Review two
  // thirds and chat one third, then preserves that proportion across window sizes.
  // The operator's raw ratio stays persisted even if a temporarily narrower
  // pane has to clamp it to preserve a 360px floor on both columns.
  const [planSplitRowRef, planSplitRowWidth] = useContainerWidth()
  const [planSplitRatio, setPlanSplitRatio] = useState(initialPlanSplitRatio)
  const effectivePlanSplitRatio = clampedPlanSplitRatio(
    planSplitRatio,
    planSplitRowWidth
  )
  const adjustPlanSplit = useCallback(
    (deltaX: number) => {
      if (planSplitRowWidth <= 0) return
      const next = resizedPlanSplitRatio(
        effectivePlanSplitRatio,
        planSplitRowWidth,
        deltaX
      )
      setPlanSplitRatio(next)
      try {
        localStorage.setItem(PLAN_SPLIT_RATIO_KEY, String(next))
      } catch {
        /* A private/quota-limited renderer still keeps the in-memory ratio. */
      }
    },
    [effectivePlanSplitRatio, planSplitRowWidth]
  )

  const providersQuery = useQuery({ queryKey: ["config"], queryFn: () => rpc.configGet() })
  // The chips describe the values that will actually be sent. Discovery may
  // offer a recovery choice, but never projects a different harness silently.
  const providerRecovery = providerCatalog
    ? providerRecoveryOf(providerCatalog, {
        ...convo,
        connectionSelectionRequired: session.connectionSelectionRequired,
        modelSelectionRequired: session.modelSelectionRequired,
        targetId: session.environmentId ?? "desktop",
        target: environments.find((environment) => environment.id === session.environmentId)
      })
    : undefined
  const composerDisabledReason = typeof providerRecovery === "string"
    ? providerRecovery
    : providerRecovery?.message
  const mutationRecovery = useMutation({
    mutationFn: (input: { readonly runId: string; readonly callId: string }) =>
      rpc.sessionsResolveRuntimeRecovery(session.id, input.runId, input.callId),
    onSuccess: publishSessionUpdate
  })
  // Conversation text-size multiplier, scoped to the transcript wrapper below via
  // a `--sb-font-scale` CSS var. Set HERE rather than on document.documentElement
  // on purpose: the shared `.sb-md` calc() rules must only scale inside the
  // conversation, never a PR description, plan or asset preview — which render the
  // same markdown but stay put, per the setting's stated scope. Elements outside
  // this wrapper never see the var, so their calc() falls back to 1×.
  const fontScale = clampFontScale(providersQuery.data?.fontScale)
  const handoffModel = providerCatalog?.connections
    .flatMap(({ models }) => models)
    .find(({ id }) => id === convo.modelId)?.label ?? null
  const bgTasks = useBackgroundTasks(session.id)

  /**
   * Context accounting for the meter.
   *
   * Re-read when the live token count changes rather than polled: `convo.tokens`
   * moves on every `Usage` event, so keying the query on it gives a meter that
   * tracks the run without a timer running against every open session. Gated on
   * the harness reporting context at all — the meter renders nothing when
   * `triggerAt` is null, and asking for a snapshot we would not draw is waste.
   */
  const contextReporting = true
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
   * It is keyed on the exact connection and model because their context windows
   * can differ even within one provider.
   */
  const [requested, setRequested] = useState(false)
  const contextQuery = useQuery({
    queryKey: ["context", session.id, activeChat.id, convo.connectionId, convo.modelId],
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
  const draftCodeReferences = useMemo(
    () =>
      draft.references.map((reference) => ({
        path: reference.path,
        startLine: reference.startLine,
        endLine: reference.endLine,
        label: codeReferenceDisplayLabel(reference)
      })),
    [draft.references]
  )

  // A session's first turn takes one of two paths, forked by whether it was just
  // created from the new-session composer (`first-message-store` holds a handoff
  // for it) or arrived here some other way (e.g. a legacy prefilled task):
  //
  //  - New-session composer: auto-send the first turn NOW — the operator already
  //    pressed send once; the `initialPrompt` text plus any attachments go
  //    straight to the agent instead of sitting as a draft to send again.
  //  - Otherwise: seed the DRAFT STORE (once ever, never over existing text).
  //    The prefilled task is one-shot, but we clear it (backend + app state) only
  //    once the user actually SENDS — not on mount. Clearing on mount lost the
  //    draft when the user visited another tab first (that unmounts this pane,
  //    discarding the composer's seeded text; on return `initialPrompt` was
  //    already gone). Consuming on send keeps the seed alive across those
  //    unmounts until it's used.
  //
  // `sendPrompt` (below) itself consumes `initialPrompt` and clears the draft, so
  // the auto-send path never also leaves a stray seeded draft behind.
  useEffect(() => {
    const firstTurnImages = takeFirstMessage(session.id)
    if (firstTurnImages !== undefined) {
      const text = session.initialPrompt ?? ""
      if (text.trim() || firstTurnImages.length > 0) {
        sendPrompt(text, firstTurnImages.length > 0 ? firstTurnImages : undefined)
      }
      return
    }
    if (session.initialPrompt) {
      seedDraftOnce(activeChat.id, session.initialPrompt, session.id)
    }
  }, [activeChat.id, session.id, session.initialPrompt])

  const sendPrompt: typeof convo.sendPrompt = (text, images) => {
    // Structured ranges stay out of the editable textarea, but every harness
    // receives the same deterministic plain-text context at the turn boundary.
    // Read the store now rather than using the render snapshot: Files can append
    // a reference between this pane's last render and the operator pressing send.
    const agentContext = serializeCodeReferences(getDraft(activeChat.id).references)
    if (session.initialPrompt) onInitialPromptConsumed?.(session.id)
    // The turn is on its way to the agent — the draft has served its purpose.
    clearDraft(activeChat.id)
    // Titles reflect the operator's visible message, never the appended context.
    if (activeChat.title === null && text.trim()) {
      const title = text.trim().split("\n")[0]!.slice(0, 48)
      void rpc
        .sessionsRenameChat(session.id, activeChat.id, title)
        .then(publishSessionUpdate)
    }
    return convo.sendPrompt(text, images, agentContext)
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
        actor.send({
          type: "SEND",
          text: item.text,
          images: item.images,
          agentContext: item.agentContext
        })
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
   * Fetch one transcript image's bytes. `Sessions.transcriptPage` leaves them out —
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

  const legacyFleetAgents = useMemo(
    () => convo.reviewer === null
      ? convo.subagents
      : [...convo.subagents, convo.reviewer],
    [convo.reviewer, convo.subagents]
  )
  const fleet = useSubagentFleet({
    sessionId: session.id,
    chatId: activeChat.id,
    piSessionId: activeChat.piSessionId ?? null,
    events: convo.subagentFleetEvents,
    legacyAgents: legacyFleetAgents
  })
  const childTranscriptQuery = useQuery({
    queryKey: [
      "subagent-transcript",
      session.id,
      activeChat.id,
      fleet.selectedNode?.parentPiSessionId,
      fleet.selectedNode?.runId,
      fleet.selectedNode?.updatedAt
    ],
    queryFn: () => rpc.agentSubagentTranscript(
      session.id,
      activeChat.id,
      fleet.selectedNode!.parentPiSessionId,
      fleet.selectedNode!.runId
    ),
    enabled:
      fleet.selectedNode !== null &&
      fleet.selectedLegacyAgent === null &&
      fleet.selectedNode.sessionFile !== null,
    refetchInterval: fleet.selectedNode?.status === "running" ? 1_500 : false
  })
  const fleetDrawer = (
    <FleetDrawer
      nodes={fleet.nodes}
      selectedId={fleet.selectedId}
      expanded={fleet.expanded}
      height={fleet.height}
      pending={fleet.pending}
      outcomeMessage={fleet.lastOutcome?.message ?? null}
      onSelect={fleet.select}
      onToggle={fleet.toggle}
      onResize={fleet.resize}
      canControl={(node, action) => {
        const legacy = fleet.legacyAgentFor(node)
        if (legacy === null) return true
        return legacy.status === "working" &&
          convo.subagents.some(({ id }) => id === legacy.id) &&
          action === "stop"
      }}
      canDismiss={(node) => {
        const legacy = fleet.legacyAgentFor(node)
        return legacy !== null &&
          legacy.status !== "working" &&
          convo.subagents.some(({ id }) => id === legacy.id)
      }}
      onDismiss={(node) => {
        const legacy = fleet.legacyAgentFor(node)
        if (legacy !== null) convo.closeSubagent(legacy.id)
      }}
      onControl={(node, action, message, replyTo) => {
        const legacy = fleet.legacyAgentFor(node)
        if (legacy !== null) {
          if (action === "stop" && legacy.status === "working") {
            convo.stopSubagent(legacy.id)
          }
          return
        }
        fleet.control(node, action, message, replyTo).catch(() => {})
      }}
      onOpenArtifact={(path) => onOpenFile?.(session.id, path)}
    />
  )

  // Live agent status + Plan-tab presence are published by the conversation
  // registry (from the actor's own subscription), so they stay correct even
  // while this pane is unmounted for a background session. Nothing to do here.

  const planId = canonicalPlan.document?.id ?? convo.plan?.id ?? null

  const planReview = (
    <PlanReview
      plan={convo.plan}
      document={canonicalPlan.document}
      streamingDraft={convo.planDraft}
      draft={canonicalPlan.draft}
      syncState={canonicalPlan.state}
      syncError={canonicalPlan.error ?? convo.planActionError}
      canApprove={canApprovePlan}
      compact={view === "split"}
      patch={convo.patch}
      knownFiles={knownFiles}
      onOpenFile={openAsset}
      selectedStepId={planStepId}
      revisionTarget={canonicalPlan.revisionTarget}
      onSelectStep={onPlanStepSelected}
      onApprove={(executionMode) =>
        planId &&
        convo.approvePlan(planId, executionMode, canonicalPlan.document?.revision)
      }
      onResume={() =>
        planId && convo.resumePlan(planId, canonicalPlan.document?.revision)
      }
      onRevise={() => {
        if (!planId) return
        canonicalPlan.beginRevision(null)
        convo.revisePlan(planId)
      }}
      onComment={(stepId, body) => planId && convo.commentPlanStep(planId, stepId, body)}
      onAddComment={(target, body) => {
        if (!planId) return
        canonicalPlan.beginRevision(target.stageId ?? null)
        convo.commentPlanStep(planId, target.stageId ?? "", body, target.anchor)
      }}
      onStartDraft={canonicalPlan.startDraft}
      onSendToAgent={() => {
        // Hand the draft to the agent as a plan-mode turn: switch into plan mode
        // and send the draft plan (the structured DTO) as the starting point. The
        // agent proposes a refined plan, which replaces the draft as canonical.
        const source =
          canonicalPlan.draft ??
          (canonicalPlan.document ? JSON.stringify(canonicalPlan.document.plan, null, 2) : "")
        convo.setMode("plan")
        convo.sendPrompt(
          [
            "I've drafted the plan below. Treat it as the starting point:",
            "review it, fill in the gaps, and propose a complete plan.",
            "",
            "```json",
            source.trim(),
            "```"
          ].join("\n")
        )
      }}
      onRetryDocument={canonicalPlan.retry}
      onReplyThread={async (annotationId, body, mentionedParticipantIds) => {
        const document = canonicalPlan.document
        if (document === null) return
        await runWithDirectPlanThreadDispatch(
          document.id,
          annotationId,
          () => convo.dispatchPlanMessage({
            planId: document.id,
            baseRevision: document.revision,
            annotationId,
            body,
            authorId: "operator",
            mentionedParticipantIds
          })
        )
      }}
      onRetryThread={async (annotationId, message) => {
        const document = canonicalPlan.document
        if (document === null) return
        await rpc.planDispatchExistingMessage({
          sessionId: session.id,
          planId: document.id,
          baseRevision: document.revision,
          annotationId,
          messageId: message.id
        })
      }}
      onSetThreadResolved={async (annotationId, resolved) => {
        const document = canonicalPlan.document
        if (document === null) return
        const setResolved = (baseRevision: number) =>
          rpc.planSetThreadResolved({
            sessionId: session.id,
            planId: document.id,
            baseRevision,
            annotationId,
            resolved,
            author: "user"
          })
        try {
          await setResolved(document.revision)
        } catch (error) {
          const latestRevision = rpcFailureNumber(error, "latestRevision")
          if (
            rpcFailureTag(error) !== "PlanConflictError" ||
            latestRevision === undefined
          ) {
            throw error
          }
          // Setting a thread's resolved state is idempotent. Plan.watch can
          // briefly lag the mutation response, so retry this one safe write at
          // the server-provided canonical revision instead of surfacing a
          // conflict for a revision the user never edited directly.
          await setResolved(latestRevision)
        }
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
    <div ref={planSplitRowRef} className="flex min-h-0 min-w-0 flex-1" style={{ "--sb-font-scale": fontScale } as CSSProperties}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {continuationEnvironmentId !== null && (
        <div
          role="alert"
          className="flex flex-none items-center gap-2 border-b border-yellow/30 bg-yellow/[0.06] px-3 py-2 text-[11px] text-fg"
        >
          <span className="min-w-0 flex-1">
            {convo.busy
              ? "Stop the active turn, checkpoint its current work, and continue as a new session on the selected environment?"
              : "This session already has work. Continue it as a new session on the selected environment?"}
          </span>
          <button
            type="button"
            onClick={() => {
              if (convo.busy) {
                setHandoffAfterStop({
                  environmentId: continuationEnvironmentId
                })
                convo.stop()
                return
              }
              continueEnvironmentMutation.mutate(continuationEnvironmentId)
            }}
            disabled={
              continueEnvironmentMutation.isPending || handoffAfterStop !== null
            }
            className="flex-none rounded border border-border px-2 py-1 outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {convo.busy ? "Stop and continue there" : "Continue there"}
          </button>
          <button
            type="button"
            aria-label="Cancel environment continuation"
            onClick={() => {
              setContinuationEnvironmentId(null)
              setHandoffAfterStop(null)
            }}
            className="flex-none rounded px-1 outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring"
          >
            ×
          </button>
        </div>
      )}
      {environmentMutation.error !== null &&
        !(
          rpcFailureTag(environmentMutation.error) === "EnvironmentHandoffError" &&
          rpcFailureReason(environmentMutation.error) === "has-work"
        ) && (
          <div
            role="alert"
            className="flex flex-none items-center gap-2 border-b border-red/30 bg-red/5 px-3 py-2 text-[11px] text-red"
          >
            <span className="min-w-0 flex-1">
              {rpcFailureMessage(
                environmentMutation.error,
                "Could not update the session environment."
              )}
            </span>
            <button
              type="button"
              aria-label="Dismiss environment error"
              onClick={() => environmentMutation.reset()}
              className="flex-none rounded px-1 text-red outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring"
            >
              ×
            </button>
          </div>
        )}
      {continueEnvironmentMutation.error !== null && (
        <div
          role="alert"
          className="flex flex-none items-center gap-2 border-b border-red/30 bg-red/5 px-3 py-2 text-[11px] text-red"
        >
          <span className="min-w-0 flex-1">
            {rpcFailureMessage(
              continueEnvironmentMutation.error,
              "Could not continue the session on that environment."
            )}
          </span>
          <button
            type="button"
            aria-label="Dismiss environment continuation error"
            onClick={() => continueEnvironmentMutation.reset()}
            className="flex-none rounded px-1 text-red outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring"
          >
            ×
          </button>
        </div>
      )}
      {typeof providerRecovery !== "string" && providerRecovery !== undefined && (
        <RuntimeRecoveryCard
          title={providerRecovery.title}
          message={providerRecovery.message}
          actionLabel="Open providers"
          onAction={() => onOpenProviderSettings?.()}
        />
      )}
      {session.runtimeRecovery?.uncertainMutations.map((mutation) => (
        <RuntimeRecoveryCard
          key={`${mutation.runId}:${mutation.callId}`}
          title="Inspect an uncertain workspace mutation"
          message="Jingler restarted before this tool settled. The call will not be replayed; inspect the workspace before continuing."
          detail={`${mutation.toolId} · ${mutation.targetCategory ?? "workspace"} · ${mutation.startedAt}`}
          actionLabel={mutationRecovery.isPending ? "Saving…" : "Mark inspected"}
          actionDisabled={mutationRecovery.isPending}
          onAction={() => mutationRecovery.mutate({ runId: mutation.runId, callId: mutation.callId })}
          onInspect={() => onSelectChanges?.()}
        />
      ))}
      {fleet.selectedId !== MAIN_FLEET_AGENT && fleet.selectedNode ? (
        <FleetAgentView
          node={fleet.selectedNode}
          messages={
            fleet.selectedLegacyAgent === null
              ? (childTranscriptQuery.data ?? [])
              : [fleet.selectedLegacyAgent.message]
          }
          providerId={session.providerId}
          loading={
            fleet.selectedLegacyAgent === null && childTranscriptQuery.isLoading
          }
          error={
            fleet.selectedLegacyAgent === null && childTranscriptQuery.error
              ? rpcFailureMessage(childTranscriptQuery.error, "Could not load the child transcript.")
              : null
          }
          fleetSlot={fleetDrawer}
        />
      ) : (
        <ConversationView
          messages={convo.messages}
          fleetSlot={fleetDrawer}
          hasMoreHistory={convo.hasMoreHistory}
          loadingHistory={convo.loadingHistory}
          onLoadEarlier={convo.loadOlder}
          mode={convo.mode}
          skills={convo.skills}
          files={convo.files}
          paused={convo.paused}
          branch={session.branch}
          branchPending={session.semanticBranchPending === true}
          repo={session.repo}
          environments={environments}
          environmentId={session.environmentId}
          environmentPending={environmentMutation.isPending}
          onSetEnvironment={(environmentId) => {
            if (convo.busy && environmentId !== session.environmentId) {
              // The persisted Session can lag the renderer's live actor during
              // its first turn. A running checkout is never safe to reassign in
              // place, so enter the explicit stop/checkpoint/continue flow here
              // instead of waiting for stale counters to catch up.
              setContinuationEnvironmentId(environmentId)
              return
            }
            environmentMutation.mutate(environmentId)
          }}
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
          providerCatalog={providerCatalog}
          connectionId={convo.connectionId}
          providerId={convo.providerId}
          modelId={convo.modelId}
          composerDisabledReason={composerDisabledReason}
          onSetModel={({ connectionId, providerId, modelId }) =>
            convo.setModel(connectionId, providerId, modelId)
          }
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
            canApprovePlan && canonicalPlan.document !== null
              ? (id, executionMode) =>
                  convo.approvePlan(id, executionMode, canonicalPlan.document?.revision)
              : undefined
          }
          onResumePlan={
            canApprovePlan && canonicalPlan.document !== null
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
          draftCodeReferences={draftCodeReferences}
          onDraftCodeReferenceRemove={(index) => {
            const current = getDraft(activeChat.id)
            setDraft(activeChat.id, {
              ...current,
              references: current.references.filter((_, currentIndex) => currentIndex !== index)
            })
          }}
          onDraftCodeReferencesClear={() =>
            setDraft(activeChat.id, { ...getDraft(activeChat.id), references: [] })
          }
          // The Plan face returns early above, so reaching here already means the
          // transcript is on screen — only the focused pane still has to be checked.
          autoFocusComposer={paneFocused}
          focusKey={activeChat.id}
          followAgent={fileBrowser.followEnabled}
          onToggleFollowAgent={toggleFollowAgent}
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
        Background tasks dock — runtime work that OUTLIVES this turn. Sits below
        the conversation (not in the sub-agent tab bar, which is per-run and
        cleared on the next turn) so a task the operator needs to stop can't be
        swept away while it is still running. Renders nothing when there is no
        task to show.
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
        supported
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
          <ResizeHandle aria-label="Resize plan" onResize={adjustPlanSplit} />
          <div
            data-testid="plan-split-column"
            style={{
              width: `calc(${effectivePlanSplitRatio * 100}% - ${effectivePlanSplitRatio * PLAN_SPLIT_HANDLE_WIDTH}px)`
            }}
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
