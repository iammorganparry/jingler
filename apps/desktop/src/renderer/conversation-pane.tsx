/**
 * Bridges the renderer's conversation machine to the presentational
 * `ConversationView` and embedded Plannotator review. Mounted keyed by session
 * id (see `JinglerApp`), so each session drives its own machine instance. The
 * machine lives above the Conversation ↔ Plan switch, so opening Plannotator
 * does not unmount the agent stream.
 */
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import type {
  Environment,
  Message,
  ProviderCatalog,
  Session,
  SubagentFleetControlAction,
  ThemeTokens,
  SubagentFleetControlOutcome,
  SubagentFleetNode
} from "@jingler/core"
import {
  agentFileActivityOf,
  clampFontScale,
  plannotatorProjectionToPlanDocument
} from "@jingler/core"
import {
  AttachmentSourceProvider,
  OpenAssetProvider,
  BackgroundTaskDock,
  BackgroundTaskOutput,
  Composer,
  ConversationView,
  FleetAgentView,
  ResizeHandle,
  RuntimeRecoveryCard,
  useContainerWidth,
  useHasNativeEclipsingOverlay,
  useThemeTokens
} from "@jingler/ui"
import { rpc } from "./rpc-client.js"
import { publishFleetAgentFileActivity } from "./agent-file-activity.js"
import { publishSessionUpdate } from "./session-updates.js"
import {
  disposeChatActor,
  getConversationActor
} from "./conversation-registry.js"
import { clearDraft, getDraft, markDraftSeeded, seedDraftOnce, setDraft, useDraft } from "./draft-store.js"
import { useSessionDiffs } from "./diff-presence.js"
import { takeFirstMessage } from "./first-message-store.js"
import {
  codeReferenceDisplayLabel,
  serializeCodeReferences
} from "./code-reference.js"
import { useConversation } from "./use-conversation.js"
import { MAIN_FLEET_AGENT, useSubagentFleet } from "./use-subagent-fleet.js"
import {
  publishSubagentTabs,
  releaseSubagentTabController,
  useSubagentTabSelection
} from "./subagent-tab-store.js"
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
  rpcFailureReason,
  rpcFailureTag
} from "./rpc-failure.js"
import { providerRecoveryOf } from "./provider-recovery.js"
import { useNativeViewBounds } from "./use-native-view-bounds.js"

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

const PLANNOTATOR_CSS_VARIABLE = /(--[\w-]+:\s*[^;]+);/g

const plannotatorThemeCss = (tokens: ThemeTokens): string => {
  const scheme = tokens.kind === "light" ? "light" : "dark"
  return `
:root, .dark, [data-theme="light"] {
  color-scheme: ${scheme};
  --background: ${tokens.canvas};
  --foreground: ${tokens.textBody};
  --card: ${tokens.panel};
  --card-foreground: ${tokens.textBright};
  --popover: ${tokens.panel};
  --popover-foreground: ${tokens.textBright};
  --primary: ${tokens.brand};
  --primary-foreground: ${tokens.canvas};
  --secondary: ${tokens.surface};
  --secondary-foreground: ${tokens.textBody};
  --muted: ${tokens.surface};
  --muted-foreground: ${tokens.muted};
  --accent: ${tokens.brand};
  --accent-foreground: ${tokens.canvas};
  --destructive: ${tokens.red};
  --success: ${tokens.green};
  --warning: ${tokens.yellow};
  --border: ${tokens.line};
  --input: ${tokens.line};
  --ring: ${tokens.brand};
  --code-bg: ${tokens.editor};
  --focus-highlight: ${tokens.selection};
  --surface-0: ${tokens.canvas};
  --surface-1: ${tokens.panel};
  --surface-2: ${tokens.surface};
  --atomic-editor-bg: ${tokens.editor};
  --atomic-editor-bg-panel: ${tokens.panel};
  --atomic-editor-bg-surface: ${tokens.surface};
  --atomic-editor-border: ${tokens.line};
  --atomic-editor-accent: ${tokens.brand};
  --atomic-editor-fg: ${tokens.textBody};
  --atomic-editor-fg-muted: ${tokens.muted};
  --atomic-editor-fg-faint: ${tokens.dim};
}
body { background: ${tokens.canvas}; color: ${tokens.textBody}; }
`.replace(PLANNOTATOR_CSS_VARIABLE, "$1 !important;")
}

function PlannotatorPlanView({
  sessionId,
  chatId,
  url
}: {
  readonly sessionId: string
  readonly chatId: string
  readonly url: string
}) {
  const overlayOpen = useHasNativeEclipsingOverlay()
  const themeTokens = useThemeTokens()
  const themeCss = useMemo(() => plannotatorThemeCss(themeTokens), [themeTokens])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const loadId = useRef(0)
  const appliedThemeCss = useRef(themeCss)
  const boundsRef = useNativeViewBounds({
    active: true,
    onFirstPaintableRect: (rect) => {
      const id = ++loadId.current
      setLoadError(null)
      setLoaded(false)
      appliedThemeCss.current = themeCss
      void rpc.plannotatorPreviewOpen(sessionId, chatId, url, rect, themeCss).then(() => {
        if (loadId.current === id) setLoaded(true)
      }).catch((error: unknown) => {
        if (loadId.current !== id) return
        setLoadError(error instanceof Error ? error.message : "Plannotator failed to load")
        void rpc.plannotatorPreviewClose(sessionId, chatId)
      })
    },
    onBoundsChanged: (rect) => {
      void rpc.plannotatorPreviewSetBounds(sessionId, chatId, rect)
    }
  })

  useEffect(() => {
    loadId.current += 1
    setLoadError(null)
    setLoaded(false)
  }, [url])

  useEffect(() => {
    if (!loaded || appliedThemeCss.current === themeCss) return
    appliedThemeCss.current = themeCss
    void rpc.plannotatorPreviewSetTheme(sessionId, chatId, themeCss)
  }, [chatId, loaded, sessionId, themeCss])

  useEffect(() => {
    void rpc.plannotatorPreviewSetVisible(
      sessionId,
      chatId,
      !overlayOpen && loaded && loadError === null
    )
  }, [chatId, loadError, loaded, overlayOpen, sessionId])

  useEffect(
    () => () => {
      loadId.current += 1
      void rpc.plannotatorPreviewSetVisible(sessionId, chatId, false)
    },
    [chatId, sessionId]
  )

  return (
    <div className="relative min-h-0 flex-1 bg-editor">
      <div ref={boundsRef} className="absolute inset-0" />
      {!loaded && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-8 text-center text-[12px] text-dim">
          {loadError === null
            ? "Loading Plannotator…"
            : `Could not open Plannotator. ${loadError}`}
        </div>
      )}
    </div>
  )
}

export function ConversationPane({
  session,
  view = "conversation",
  onOpenPlanReview,
  onPlanDraftAvailable,
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
  /** Switch the pane to the active embedded Plannotator review. */
  onOpenPlanReview?: (stepId?: string) => void
  /** Auto-present a newly active Plannotator review at the host's responsive width. */
  onPlanDraftAvailable?: () => void
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
  const plannotatorReviewId = convo.plannotator?.review?.reviewId ?? null
  const priorPlannotatorReview = useRef<string | null>(null)
  useEffect(() => {
    const prior = priorPlannotatorReview.current
    if (prior !== null && prior !== plannotatorReviewId) {
      void rpc.plannotatorPreviewClose(session.id, activeChat.id)
    }
    priorPlannotatorReview.current = plannotatorReviewId
  }, [activeChat.id, plannotatorReviewId, session.id])
  useEffect(
    () => () => {
      void rpc.plannotatorPreviewClose(session.id, activeChat.id)
    },
    [activeChat.id, session.id]
  )
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
  const presentedPlannotatorReview = useRef<string | null>(null)
  useEffect(() => {
    const reviewId = convo.plannotator?.review?.reviewId ?? null
    if (reviewId === null || reviewId === presentedPlannotatorReview.current) return
    presentedPlannotatorReview.current = reviewId
    if (onPlanDraftAvailable !== undefined && claimPlanAutoPresentation(activeChat.id)) {
      onPlanDraftAvailable()
    }
  }, [activeChat.id, convo.plannotator?.review?.reviewId, onPlanDraftAvailable])
  // Branch-drift recovery (the `BranchDrift` banner). Stable per session so the
  // memoised transcript turns don't re-render while a turn streams. Adopt updates
  // this session in place; fork publishes a NEW worktree session into the sidebar
  // (the operator opens it) and leaves this one pinned to its original branch.
  const onAdoptBranchStable = useCallback(
    () =>
      rpc.sessionsAdoptBranch(session.id).then(publishSessionUpdate).then(() => {}),
    [session.id]
  )
  const onForkOntoBranchStable = useCallback(
    () =>
      rpc
        .sessionsForkOntoBranch(session.id)
        .then(publishSessionUpdate)
        .then(() => {}),
    [session.id]
  )
  // Everything the transcript needs to turn a path into a link. `convo.files` is
  // the worktree's tracked-file list, already fetched for the composer's `@`
  // menu — reusing it is what keeps the false-positive gate free.
  const knownFiles = useMemo(() => new Set(convo.files), [convo.files])
  const onOpenFileRef = useRef(onOpenFile)
  onOpenFileRef.current = onOpenFile
  const openAsset = useCallback(
    (path: string) => onOpenFileRef.current?.(session.id, path),
    [session.id]
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
  // Same live-drag discipline as the session auxiliary split: a drag's
  // per-pointermove deltas write the column width to the DOM directly, and
  // React state commits ONCE on release — a setState per move re-rendered the
  // conversation AND the whole Plan Review per mouse movement.
  const planSplitColumnRef = useRef<HTMLDivElement | null>(null)
  const dragPlanSplitRatio = useRef<number | null>(null)
  const livePlanSplitState = useRef({
    ratio: effectivePlanSplitRatio,
    rowWidth: planSplitRowWidth,
  })
  livePlanSplitState.current = {
    ratio: effectivePlanSplitRatio,
    rowWidth: planSplitRowWidth,
  }
  const planSplitColumnWidth = (ratio: number): string =>
    `calc(${ratio * 100}% - ${ratio * PLAN_SPLIT_HANDLE_WIDTH}px)`
  const adjustPlanSplit = useCallback((deltaX: number) => {
    const { ratio, rowWidth } = livePlanSplitState.current
    if (rowWidth <= 0) return
    const next = resizedPlanSplitRatio(
      dragPlanSplitRatio.current ?? ratio,
      rowWidth,
      deltaX
    )
    dragPlanSplitRatio.current = next
    const column = planSplitColumnRef.current
    if (column) column.style.width = planSplitColumnWidth(next)
  }, [])
  const commitPlanSplit = useCallback(() => {
    const next = dragPlanSplitRatio.current
    dragPlanSplitRatio.current = null
    if (next === null) return
    setPlanSplitRatio(next)
    try {
      localStorage.setItem(PLAN_SPLIT_RATIO_KEY, String(next))
    } catch {
      /* A private/quota-limited renderer still keeps the in-memory ratio. */
    }
  }, [])

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
  const liveDiffs = useSessionDiffs()

  // Catch changes made outside agent turns (editor saves, manual commits): the
  // per-ToolEnd refresh can't see them, so re-read the worktree diff whenever
  // this session's pane becomes active. Routed through the MACHINE rather than
  // written straight to the diff store: a direct store write raced the
  // registry's own publishes (each chat re-asserting its snapshot), and the
  // composer's diff chip flashed between the two readings. The machine stamps
  // the read's freshness, and the registry follows the freshest. Dropped while
  // a turn is running — the per-ToolEnd refresh owns that window.
  const refreshDiffStable = convo.refreshDiff
  useEffect(() => {
    if (!session.worktreePath) return
    refreshDiffStable()
  }, [session.id, session.worktreePath, refreshDiffStable])

  useEffect(() => {
    const firstTurnImages = takeFirstMessage(session.id)
    if (firstTurnImages !== undefined) {
      // The prompt goes straight to the agent — latch the seed key so a re-run
      // of this effect (a SESSION_UPDATED can land before `initialPrompt`'s
      // async clear) cannot resurrect the sent text into the composer.
      markDraftSeeded(session.id)
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
  const [subagentControlOutcome, setSubagentControlOutcome] = useState<
    SubagentFleetControlOutcome | null
  >(null)
  const controlSubagent = (
    node: SubagentFleetNode,
    action: SubagentFleetControlAction,
    message?: string,
    replyTo?: string
  ) => fleet.control(node, action, message, replyTo).then((outcome) => {
    setSubagentControlOutcome(outcome)
    return outcome
  })
  useEffect(() => setSubagentControlOutcome(null), [fleet.selectedNode?.id])
  const childTranscriptQuery = useQuery({
    queryKey: [
      "subagent-transcript",
      session.id,
      activeChat.id,
      fleet.selectedNode?.parentPiSessionId,
      fleet.selectedNode?.runId
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
      fleet.selectedNode.sessionFile !== null
  })
  useEffect(() => {
    if (
      fleet.selectedNode?.status === "running" &&
      fleet.selectedNode.sessionFile !== null
    ) void childTranscriptQuery.refetch()
  }, [
    childTranscriptQuery.refetch,
    fleet.selectedNode?.id,
    fleet.selectedNode?.sessionFile,
    fleet.selectedNode?.status,
    fleet.selectedNode?.updatedAt
  ])
  // Selecting a Fleet agent redirects the file browser's Follow to THAT
  // agent's edits: its file activity is derived from its own transcript with
  // the same pure deriver the main chat uses, and published as the session's
  // fleet override (which wins in `useAgentFileActivity`). Cleared whenever
  // the selection returns to Main — Follow then tracks the main chat again.
  const selectedChildMessages: ReadonlyArray<Message> | null = useMemo(
    () =>
      fleet.selectedNode === null
        ? null
        : fleet.selectedLegacyAgent !== null
          ? [fleet.selectedLegacyAgent.message]
          : childTranscriptQuery.data ?? null,
    [childTranscriptQuery.data, fleet.selectedLegacyAgent, fleet.selectedNode]
  )
  useEffect(() => {
    if (fleet.selectedNode === null || selectedChildMessages === null) {
      publishFleetAgentFileActivity(session.id, null)
      return
    }
    const active =
      fleet.selectedNode.status === "queued" ||
      fleet.selectedNode.status === "running" ||
      fleet.selectedNode.status === "paused" ||
      fleet.selectedNode.status === "needs-attention"
    publishFleetAgentFileActivity(
      session.id,
      agentFileActivityOf(selectedChildMessages, active ? "running" : "settling")
    )
  }, [
    fleet.selectedNode,
    selectedChildMessages,
    session.id
  ])
  // A closed pane must not leave Follow pinned to a stale agent.
  useEffect(
    () => () => publishFleetAgentFileActivity(session.id, null),
    [session.id]
  )
  const activeFleetNodes = useMemo(
    () => fleet.nodes.filter((node) =>
      node.nodeKind === "agent" &&
      ["queued", "running", "paused", "needs-attention"].includes(node.status)
    ),
    [fleet.nodes]
  )
  const completedFleetNodes = useMemo(() => {
    const completed = new Map(fleet.completedNodes.map((node) => [node.id, node]))
    for (const node of fleet.nodes) {
      if (
        node.nodeKind === "agent" &&
        ["completed", "failed", "stopped", "unknown"].includes(node.status)
      ) completed.set(node.id, node)
    }
    return [...completed.values()].slice(-8).reverse()
  }, [fleet.completedNodes, fleet.nodes])
  useEffect(() => {
    publishSubagentTabs(session.id, {
      chatId: activeChat.id,
      active: activeFleetNodes,
      completed: completedFleetNodes,
      selectedId: fleet.selectedId
    })
  }, [activeChat.id, activeFleetNodes, completedFleetNodes, fleet.selectedId, session.id])
  useEffect(
    () => () => releaseSubagentTabController(session.id, activeChat.id),
    [activeChat.id, session.id]
  )
  const subagentTabSelection = useSubagentTabSelection(session.id)
  const selectFleetRef = useRef(fleet.select)
  selectFleetRef.current = fleet.select
  useEffect(() => {
    if (subagentTabSelection?.chatId === activeChat.id) {
      selectFleetRef.current(subagentTabSelection.nodeId)
    }
  }, [activeChat.id, subagentTabSelection?.chatId, subagentTabSelection?.nodeId, subagentTabSelection?.nonce])

  // Live agent status + Plan-tab presence are published by the conversation
  // registry (from the actor's own subscription), so they stay correct even
  // while this pane is unmounted for a background session. Nothing to do here.

  const plannotatorDocument = useMemo(
    () => convo.plannotator
      ? plannotatorProjectionToPlanDocument(
          convo.plannotator,
          session.id,
          activeChat.id,
          new Date().toISOString()
        )
      : null,
    [activeChat.id, convo.plannotator, session.id]
  )
  const nativePlanDocument = plannotatorDocument
  const planSurface = convo.plannotator?.review
    ? (
        <PlannotatorPlanView
          key={convo.plannotator.review.reviewId}
          sessionId={session.id}
          chatId={activeChat.id}
          url={convo.plannotator.review.url}
        />
      )
    : null

  if (view === "plan") {
    return (
      <OpenAssetProvider
        open={openAsset}
        knownFiles={knownFiles}
        worktreeRoot={session.worktreePath}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          {planSurface}
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
      {mutationRecovery.error !== null && (
        <div
          role="alert"
          className="flex flex-none items-center gap-2 border-b border-red/30 bg-red/5 px-3 py-2 text-[11px] text-red"
        >
          <span className="min-w-0 flex-1">
            {rpcFailureMessage(
              mutationRecovery.error,
              "Could not mark the mutation inspected."
            )}
          </span>
          <button
            type="button"
            aria-label="Dismiss mutation recovery error"
            onClick={() => mutationRecovery.reset()}
            className="flex-none rounded px-1 text-red outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring"
          >
            ×
          </button>
        </div>
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
        // The child view keeps the REAL composer: same input the operator
        // already lives in, aimed at the selected agent. Model, reasoning,
        // mode, and environment pickers are omitted — those are main-turn
        // choices — and the composer's follow toggle points at this agent.
        <>
          <FleetAgentView
            node={fleet.selectedNode}
            messages={
              fleet.selectedLegacyAgent === null
                ? (childTranscriptQuery.data ?? [])
                : [fleet.selectedLegacyAgent.message]
            }
            providerId={session.providerId}
            controlOutcome={subagentControlOutcome}
            onOpenArtifact={(path) => onOpenFile?.(session.id, path)}
            loading={
              fleet.selectedLegacyAgent === null && childTranscriptQuery.isLoading
            }
            error={
              fleet.selectedLegacyAgent === null && childTranscriptQuery.error
                ? rpcFailureMessage(childTranscriptQuery.error, "Could not load the child transcript.")
                : null
            }
          />
          {/* Same gutter + centered max-width as the transcript column above —
              a full-bleed composer read as a different surface entirely. */}
          <div className="flex-none px-[30px] pb-[18px] pt-[11px]">
          <div className="mx-auto w-full max-w-[760px]">
          <Composer
            repo={session.repo}
            branch={session.branch}
            branchPending={session.semanticBranchPending === true}
            busy={
              fleet.selectedNode.status === "queued" ||
              fleet.selectedNode.status === "running" ||
              fleet.selectedNode.status === "paused" ||
              fleet.selectedNode.status === "needs-attention"
            }
            placeholder={
              fleet.selectedNode.status === "paused"
                ? `Resume ${fleet.selectedNode.agent} with a continuation…`
                : fleet.selectedNode.attention
                  ? `Reply to ${fleet.selectedNode.agent}…`
                  : `Steer ${fleet.selectedNode.agent}…`
            }
            disabledReason={
              fleet.selectedLegacyAgent !== null
                ? "Inline agents are watch-only — steer them through the main chat."
                : undefined
            }
            onSend={(text) => {
              const node = fleet.selectedNode
              if (node === null || fleet.selectedLegacyAgent !== null) return
              controlSubagent(
                node,
                node.status === "paused"
                  ? "resume"
                  : node.attention
                    ? "reply"
                    : "steer",
                text,
                node.attention?.requestId
              ).catch(() => {})
            }}
            onStop={() => {
              const node = fleet.selectedNode
              if (node === null) return
              const legacy = fleet.legacyAgentFor(node)
              if (legacy !== null) {
                if (legacy.status === "working") convo.stopSubagent(legacy.id)
                return
              }
              controlSubagent(node, "stop").catch(() => {})
            }}
            followAgent={fileBrowser.followEnabled}
            onToggleFollowAgent={toggleFollowAgent}
            autoFocus={paneFocused}
            focusKey={fleet.selectedNode.id}
          />
          </div>
          </div>
        </>
      ) : (
        <ConversationView
          messages={convo.messages}
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
          diff={liveDiffs[session.id] ?? null}
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
          onOpenPlanReview={onOpenPlanReview}
          onForkOntoBranch={onForkOntoBranchStable}
          onAdoptBranch={onAdoptBranchStable}
          planDocument={nativePlanDocument}
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
          <ResizeHandle
            aria-label="Resize plan"
            onResize={adjustPlanSplit}
            onResizeEnd={commitPlanSplit}
          />
          <div
            ref={planSplitColumnRef}
            data-testid="plan-split-column"
            style={{
              width: planSplitColumnWidth(effectivePlanSplitRatio)
            }}
            className="flex min-h-0 flex-none flex-col overflow-hidden border-l border-hairline"
          >
            {planSurface}
          </div>
        </>
      )}
    </div>
    </AttachmentSourceProvider>
    </OpenAssetProvider>
  )
}
