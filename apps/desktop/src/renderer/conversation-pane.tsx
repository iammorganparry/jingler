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
  AgentEndpointCatalog,
  Environment,
  McpConfigEntry,
  McpRemoteAuth,
  McpServer,
  Message,
  ProviderCatalog,
  Session,
  SubagentFleetControlAction,
  SubagentFleetControlOutcome,
  SubagentFleetNode
} from "@jingler/core"
import {
  agentFileActivityOf,
  clampFontScale,
  piEndpointId,
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
  McpApiKeyDialog,
  McpBrand,
  ResizeHandle,
  RuntimeRecoveryCard,
  PlanReview,
  useContainerWidth
} from "@jingler/ui"
import { rpc } from "./rpc-client.js"
import { endpointCatalogForSession, runtimeTargetForSession } from "./session-endpoint-catalog.js"
import {
  publishFleetAgentFileActivity,
  releaseFleetAgentFileActivityPublisher,
  retainFleetAgentFileActivityPublisher
} from "./agent-file-activity.js"
import { publishSessionUpdate } from "./session-updates.js"
import { queueSessionChatMutation } from "./session-chat-mutations.js"
import {
  disposeChatActor,
  getConversationActor
} from "./conversation-registry.js"
import { clearDraft, getDraft, markDraftSeeded, seedDraftOnce, setDraft, useDraft, type Draft } from "./draft-store.js"
import { useSessionDiffs, type LiveDiffStat } from "./diff-presence.js"
import { takeFirstMessage } from "./first-message-store.js"
import {
  codeReferenceDisplayLabel,
  serializeCodeReferences
} from "./code-reference.js"
import { useConversation, type Conversation } from "./use-conversation.js"
import { MAIN_FLEET_AGENT, useSubagentFleet, type SubagentFleetController } from "./use-subagent-fleet.js"
import {
  publishSubagentTabs,
  recentSubagentNodes,
  releaseSubagentTabController,
  retainSubagentTabController,
  useSubagentTabSelection
} from "./subagent-tab-store.js"
import { useBackgroundTasks } from "./use-background-tasks.js"
import { useFileBrowser, type FileBrowserController } from "./use-file-browser.js"
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
import { providerRebindOf, providerRecoveryOf } from "./provider-recovery.js"

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

const localMcp = (
  environmentId: string | undefined,
  servers: ReadonlyArray<McpServer> | undefined,
  add: ((name: string, entry: McpConfigEntry) => Promise<void>) | undefined,
  setApiKey: ((name: string, apiKey: string) => Promise<void>) | undefined,
  setAuth: ((name: string, auth: McpRemoteAuth) => Promise<void>) | undefined,
  authorize: ((name: string) => Promise<void>) | undefined
) => environmentId === undefined
  ? { servers: servers ?? [], add, setApiKey, setAuth, authorize }
  : { servers: [], add: undefined, setApiKey: undefined, setAuth: undefined, authorize: undefined }

/**
 * MCP recovery cards the operator has dismissed, for the life of the app run.
 * Module scope rather than component state: the pane remounts on every session
 * switch, and a dismissed "Reconnect runpod" reappearing on each one is the
 * nagging this exists to stop. A restart shows it again — the server still
 * needs auth, and that should not be silently forgotten forever.
 */
const dismissedMcpRecovery = new Set<string>()

const mcpRecoveryKey = (server: McpServer) => `${server.name}:${server.authKind}`

function McpRecoveryCards({
  servers,
  setApiKey,
  authorize
}: {
  readonly servers: ReadonlyArray<McpServer>
  readonly setApiKey?: (name: string, apiKey: string) => Promise<void>
  readonly authorize?: (name: string) => Promise<void>
}) {
  const [apiKeyServer, setApiKeyServer] = useState<McpServer | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [, setDismissed] = useState(0)
  const needsAuth = servers.filter((server) =>
    server.enabled && server.authState === "needs-auth" && !dismissedMcpRecovery.has(mcpRecoveryKey(server))
  )
  return (
    <>
      {error !== null && (
        <div role="alert" className="border-b border-red/30 bg-red/5 px-3 py-2 text-[11px] text-red">{error}</div>
      )}
      {needsAuth.map((server) => (
        <RuntimeRecoveryCard
          key={server.name}
          icon={<McpBrand server={server} />}
          label="MCP server recovery"
          kind="MCP server"
          title={`Reconnect ${server.displayName}`}
          message={`The ${server.displayName} MCP server needs ${server.authKind === "oauth" ? "authorization" : "a new API key"} before its tools can run. Other tools keep working.`}
          onDismiss={() => {
            dismissedMcpRecovery.add(mcpRecoveryKey(server))
            setDismissed((count) => count + 1)
          }}
          actionLabel={server.authKind === "oauth" ? "Authorize" : "Add API key"}
          actionDisabled={server.authKind === "oauth" ? authorize === undefined : setApiKey === undefined}
          onAction={() => {
            if (server.authKind === "api-key") setApiKeyServer(server)
            else {
              setError(null)
              void authorize?.(server.name).catch((cause) =>
                setError(cause instanceof Error ? cause.message : "MCP authorization failed")
              )
            }
          }}
        />
      ))}
      {setApiKey !== undefined && (
        <McpApiKeyDialog
          server={apiKeyServer}
          open={apiKeyServer !== null}
          onOpenChange={(open) => { if (!open) setApiKeyServer(null) }}
          setApiKey={setApiKey}
        />
      )}
    </>
  )
}

const activeChatFor = (session: Session) => session.chats.find((chat) => chat.id === session.activeChatId) ?? session.chats[0]!

const usePlanSplit = () => {
  const [rowRef, rowWidth] = useContainerWidth()
  const [ratio, setRatio] = useState(initialPlanSplitRatio)
  const effectiveRatio = clampedPlanSplitRatio(ratio, rowWidth)
  const columnRef = useRef<HTMLDivElement | null>(null)
  const dragRatio = useRef<number | null>(null)
  const live = useRef({ ratio: effectiveRatio, rowWidth })
  live.current = { ratio: effectiveRatio, rowWidth }
  const columnWidth = (value: number) => `calc(${value * 100}% - ${value * PLAN_SPLIT_HANDLE_WIDTH}px)`
  const adjust = useCallback((deltaX: number) => {
    const { ratio: current, rowWidth: width } = live.current
    if (width <= 0) return
    const next = resizedPlanSplitRatio(dragRatio.current ?? current, width, deltaX)
    dragRatio.current = next
    if (columnRef.current) columnRef.current.style.width = columnWidth(next)
  }, [])
  const commit = useCallback(() => {
    const next = dragRatio.current
    dragRatio.current = null
    if (next === null) return
    setRatio(next)
    try { localStorage.setItem(PLAN_SPLIT_RATIO_KEY, String(next)) } catch { /* in-memory ratio still works */ }
  }, [])
  return { rowRef, columnRef, columnWidth: columnWidth(effectiveRatio), adjust, commit }
}

const useEnvironmentHandoff = (sessionId: string, busy: boolean) => {
  const [continuationEnvironmentId, setContinuationEnvironmentId] = useState<string | undefined | null>(null)
  const [handoffAfterStop, setHandoffAfterStop] = useState<{ environmentId: string | undefined } | null>(null)
  const continueEnvironmentMutation = useMutation({
    mutationFn: (environmentId?: string) => rpc.sessionsContinueOnEnvironment(sessionId, environmentId),
    onSuccess: (continued) => {
      setContinuationEnvironmentId(null)
      setHandoffAfterStop(null)
      publishSessionUpdate(continued)
    }
  })
  const environmentMutation = useMutation({
    mutationFn: (environmentId?: string) => rpc.sessionsSetEnvironment(sessionId, environmentId),
    onSuccess: publishSessionUpdate,
    onError: (error, environmentId) => {
      if (rpcFailureTag(error) === "EnvironmentHandoffError" && rpcFailureReason(error) === "has-work") setContinuationEnvironmentId(environmentId)
    }
  })
  useEffect(() => {
    if (handoffAfterStop === null || busy) return
    const { environmentId } = handoffAfterStop
    setHandoffAfterStop(null)
    continueEnvironmentMutation.mutate(environmentId)
  }, [busy, handoffAfterStop, continueEnvironmentMutation.mutate])
  return { continuationEnvironmentId, setContinuationEnvironmentId, handoffAfterStop, setHandoffAfterStop, continueEnvironmentMutation, environmentMutation }
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
  agentEndpointCatalog,
  onSelectFiles,
  onSelectChanges,
  onOpenProviderSettings,
  onAddMcp,
  mcpServers,
  onSetMcpApiKey,
  onSetMcpAuth,
  onAuthorizeMcp,
  paneFocused = true
}: {
  session: Session
  /** Live paired-device catalogue owned by the app-level environment controller. */
  environments: ReadonlyArray<Environment>
  /** PI provider settings and recovery state. */
  providerCatalog?: ProviderCatalog | null
  /** Selectable runtime endpoints and their models. */
  agentEndpointCatalog?: AgentEndpointCatalog | null
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
  /** Add or repair global MCP connections from the composer/chat. */
  onAddMcp?: (name: string, entry: McpConfigEntry) => Promise<void>
  mcpServers?: ReadonlyArray<McpServer>
  onSetMcpApiKey?: (name: string, apiKey: string) => Promise<void>
  onSetMcpAuth?: (name: string, auth: McpRemoteAuth) => Promise<void>
  onAuthorizeMcp?: (name: string) => Promise<void>
  /**
   * Whether this is the pane the operator is looking at. Only that pane's
   * composer takes the caret when the conversation opens.
   */
  paneFocused?: boolean
}) {
  const activeChat = activeChatFor(session)
  const localMcpConfig = localMcp(
    session.environmentId,
    mcpServers,
    onAddMcp,
    onSetMcpApiKey,
    onSetMcpAuth,
    onAuthorizeMcp
  )
  const convo = useConversation(session, activeChat.id)
  const { continuationEnvironmentId, setContinuationEnvironmentId, handoffAfterStop, setHandoffAfterStop, continueEnvironmentMutation, environmentMutation } = useEnvironmentHandoff(session.id, convo.busy)
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
    const reviewId = plannotatorReviewId(convo.plannotator)
    if (reviewId === null || reviewId === presentedPlannotatorReview.current) return
    presentedPlannotatorReview.current = reviewId
    if (
      onPlanDraftAvailable !== undefined &&
      claimPlanAutoPresentation(activeChat.id, reviewId)
    ) {
      onPlanDraftAvailable()
    }
  }, [activeChat.id, plannotatorReviewId(convo.plannotator), onPlanDraftAvailable])
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

  const {
    rowRef: planSplitRowRef,
    columnRef: planSplitColumnRef,
    columnWidth: planSplitColumnWidth,
    adjust: adjustPlanSplit,
    commit: commitPlanSplit
  } = usePlanSplit()

  const providersQuery = useQuery({ queryKey: ["config"], queryFn: () => rpc.configGet() })
  const sessionTargetId = runtimeTargetForSession(session, environments)
  const sessionEndpointCatalog = endpointCatalogForSession(session, environments, agentEndpointCatalog)
  // The chips describe the values that will actually be sent. Discovery may
  // offer a recovery choice, but never projects a different harness silently.
  const { providerRecovery, rebindConnectionId, composerDisabledReason } = conversationProviderRecovery(
    session,
    convo,
    providerCatalog,
    sessionEndpointCatalog,
    environments
  )
  const effectiveComposerDisabledReason = convo.modelPending
    ? "Saving the selected agent runtime…"
    : composerDisabledReason
  const { providerId: convoProviderId, modelId: convoModelId, setModel } = convo
  useEffect(() => {
    if (rebindConnectionId === undefined) return
    if (convoProviderId == null || convoModelId == null) return
    setModel(
      "pi",
      piEndpointId(sessionTargetId, rebindConnectionId),
      rebindConnectionId,
      convoProviderId,
      convoModelId
    )
  }, [rebindConnectionId, convoProviderId, convoModelId, sessionTargetId, setModel])

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
  const fontScale = configuredFontScale(providersQuery.data)
  const handoffModel = handoffModelLabel(providerCatalog, convo)
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
  const { preparing, digestReady } = contextReadiness(contextQuery.data)
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

  const pendingReviewId = plannotatorReviewId(convo.plannotator)
  const sendPrompt: typeof convo.sendPrompt = (text, images) => {
    // Structured ranges stay out of the editable textarea, but every harness
    // receives the same deterministic plain-text context at the turn boundary.
    // Read the store now rather than using the render snapshot: Files can append
    // a reference between this pane's last render and the operator pressing send.
    const submittedDraft = getDraft(activeChat.id)
    const agentContext = serializeCodeReferences(submittedDraft.references)
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
    if (pendingReviewId !== null && (images?.length ?? 0) === 0) {
      const feedback = agentContext === "" ? text : `${text}\n\n${agentContext}`
      void rpc.planDecide(session.id, activeChat.id, pendingReviewId, false, feedback).catch(() => {
        setDraft(activeChat.id, {
          text,
          attachments: images ?? [],
          references: submittedDraft.references
        })
      })
      return
    }
    return convo.sendPrompt(text, images, agentContext)
  }

  const createChat = () => {
    queueSessionChatMutation(session.id, () => rpc.sessionsCreateChat(session.id))
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
    queueSessionChatMutation(
      session.id,
      () => rpc.sessionsCreateChat(session.id),
      (updated) => {
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
      }
    )
  }
  const selectChat = (chatId: string) => {
    queueSessionChatMutation(session.id, () => rpc.sessionsSelectChat(session.id, chatId))
  }
  const closeChat = (chatId: string) => {
    queueSessionChatMutation(
      session.id,
      () => rpc.sessionsCloseChat(session.id, chatId),
      (updated) => {
        clearDraft(chatId)
        disposeChatActor(session.id, chatId)
        publishSessionUpdate(updated)
      }
    )
  }

  useEffect(() => {
    if (!paneFocused) return
    const onKeyDown = conversationChatShortcut(closeChat, activeChat, session, selectChat)
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [session.id, session.chats, activeChat.id, paneFocused])

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
    continuation: activeChat.continuation?.id ?? null,
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
  const childTranscriptQuery = useFleetChildTranscript(session, fleet, activeChat.id)

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
  // A closed pane must not leave Follow pinned to a stale agent, but a sibling
  // chat/Plan surface for this session can still own the same Fleet projection.
  useEffect(() => {
    retainFleetAgentFileActivityPublisher(session.id)
    return () => releaseFleetAgentFileActivityPublisher(session.id)
  }, [session.id])
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
    return recentSubagentNodes([...completed.values()])
  }, [fleet.completedNodes, fleet.nodes])
  useEffect(() => {
    publishSubagentTabs(session.id, {
      chatId: activeChat.id,
      active: activeFleetNodes,
      completed: completedFleetNodes,
      selectedId: fleet.selectedId
    })
  }, [activeChat.id, activeFleetNodes, completedFleetNodes, fleet.selectedId, session.id])
  useEffect(() => {
    retainSubagentTabController(session.id, activeChat.id)
    return () => releaseSubagentTabController(session.id, activeChat.id)
  }, [activeChat.id, session.id])
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
    () => {
      const projection = convo.plannotator
      if (!projection) return null
      // Plannotator publishes host-state in every phase now (idle tracking),
      // so an empty idle projection is a real payload — but nothing to show.
      // Without this guard every session grows a hollow "Plan 0/0" drawer.
      const hasPlan =
        projection.review !== null ||
        projection.planFilePath !== null ||
        projection.checklist.length > 0
      return hasPlan
        ? plannotatorProjectionToPlanDocument(
            projection,
            session.id,
            activeChat.id,
            new Date().toISOString()
          )
        : null
    },
    [activeChat.id, convo.plannotator, session.id]
  )
  const decideReview = useCallback(
    async (approved: boolean, feedback?: string) => {
      if (pendingReviewId === null) return
      await rpc.planDecide(session.id, activeChat.id, pendingReviewId, approved, feedback)
    },
    [activeChat.id, pendingReviewId, session.id]
  )
  // The plan surface persists for as long as a plan exists. Plannotator owns
  // review actions while pending, then stays read-only as the checklist advances.
  const planSurface = renderPlanSurface(plannotatorDocument, pendingReviewId, decideReview)

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
      {renderEnvironmentNotices({
              convo,
              continuationEnvironmentId,
              handoffAfterStop,
              continueEnvironmentMutation,
              environmentMutation,
              setHandoffAfterStop,
              setContinuationEnvironmentId
            })}
      {typeof providerRecovery !== "string" && providerRecovery !== undefined && (
        <RuntimeRecoveryCard
          title={providerRecovery.title}
          message={providerRecovery.message}
          actionLabel="Open providers"
          onAction={() => onOpenProviderSettings?.()}
        />
      )}
      <McpRecoveryCards
        servers={localMcpConfig.servers}
        setApiKey={localMcpConfig.setApiKey}
        authorize={localMcpConfig.authorize}
      />
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
          {renderFleetAgent(fleet, childTranscriptQuery, session, subagentControlOutcome, onOpenFile)}
          {/* Same gutter + centered max-width as the transcript column above —
              a full-bleed composer read as a different surface entirely. */}
          <div className="flex-none px-[30px] pb-[18px] pt-[11px]">
          <div className="mx-auto w-full max-w-[760px]">
          {renderFleetComposer({
                      session,
                      addLocalMcp: localMcpConfig.add,
                      mcpServers: localMcpConfig.servers,
                      onSetMcpApiKey: localMcpConfig.setApiKey,
                      onSetMcpAuth: localMcpConfig.setAuth,
                      onAuthorizeMcp: localMcpConfig.authorize,
                      fleet,
                      controlSubagent,
                      convo,
                      fileBrowser,
                      toggleFollowAgent,
                      paneFocused
                    })}
          </div>
          </div>
        </>
      ) : (
        renderMainConversation({
                convo,
                addLocalMcp: localMcpConfig.add,
                mcpServers: localMcpConfig.servers,
                onSetMcpApiKey: localMcpConfig.setApiKey,
                onSetMcpAuth: localMcpConfig.setAuth,
                onAuthorizeMcp: localMcpConfig.authorize,
                session,
                liveDiffs,
                environments,
                environmentMutation,
                setContinuationEnvironmentId,
                contextQuery,
                preparing,
                requested,
                digestReady,
                setRequested,
                activeChat,
                handoffQueued,
                handoffModel,
                providerCatalog,
                agentEndpointCatalog: sessionEndpointCatalog,
                composerDisabledReason: effectiveComposerDisabledReason,
                sendPrompt,
                onOpenPlanReview,
                onForkOntoBranchStable,
                onAdoptBranchStable,
                plannotatorDocument,
                draft,
                draftCodeReferences,
                paneFocused,
                fileBrowser,
                toggleFollowAgent,
                onRestore,
                onDelete
              })
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
              width: planSplitColumnWidth
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

function renderFleetAgent(fleet: SubagentFleetController, childTranscriptQuery: ReturnType<typeof useFleetChildTranscript>, session: Session, subagentControlOutcome: SubagentFleetControlOutcome | null, onOpenFile: ((sessionId: string, path: string) => void) | undefined) {
  return <FleetAgentView
    node={fleet.selectedNode!}
    messages={fleet.selectedLegacyAgent === null
      ? (childTranscriptQuery.data ?? [])
      : [fleet.selectedLegacyAgent.message]}
    providerId={session.providerId}
    controlOutcome={subagentControlOutcome}
    onOpenArtifact={(path) => onOpenFile?.(session.id, path)}
    loading={fleet.selectedLegacyAgent === null && childTranscriptQuery.isLoading}
    error={fleet.selectedLegacyAgent === null && childTranscriptQuery.error
      ? rpcFailureMessage(childTranscriptQuery.error, "Could not load the child transcript.")
      : null} />
}

function handoffModelLabel(providerCatalog: ProviderCatalog | null | undefined, convo: Conversation) {
  return providerCatalog?.connections
    .flatMap(({ models }) => models)
    .find(({ id }) => id === convo.modelId)?.label ?? null
}

function renderFleetComposer({
  session,
  addLocalMcp,
  mcpServers,
  onSetMcpApiKey,
  onSetMcpAuth,
  onAuthorizeMcp,
  fleet,
  controlSubagent,
  convo,
  fileBrowser,
  toggleFollowAgent,
  paneFocused
}: {
  session: Session;
  addLocalMcp: ((name: string, entry: McpConfigEntry) => Promise<void>) | undefined;
  mcpServers: ReadonlyArray<McpServer>;
  onSetMcpApiKey: ((name: string, apiKey: string) => Promise<void>) | undefined;
  onSetMcpAuth: ((name: string, auth: McpRemoteAuth) => Promise<void>) | undefined;
  onAuthorizeMcp: ((name: string) => Promise<void>) | undefined;
  fleet: SubagentFleetController;
  controlSubagent: (node: SubagentFleetNode, action: SubagentFleetControlAction, message?: string, replyTo?: string) => Promise<SubagentFleetControlOutcome>;
  convo: Conversation;
  fileBrowser: FileBrowserController;
  toggleFollowAgent: (enabled: boolean) => void;
  paneFocused: boolean;
}) {
  return <Composer
    repo={session.repo}
    branch={session.branch}
    onAddMcp={addLocalMcp}
    mcpServers={mcpServers}
    onSetMcpApiKey={onSetMcpApiKey}
    onSetMcpAuth={onSetMcpAuth}
    onAuthorizeMcp={onAuthorizeMcp}
    branchPending={session.semanticBranchPending === true}
    busy={fleet.selectedNode!.status === "queued" ||
      fleet.selectedNode!.status === "running" ||
      fleet.selectedNode!.status === "paused" ||
      fleet.selectedNode!.status === "needs-attention"}
    placeholder={fleet.selectedNode!.status === "paused"
      ? `Resume ${fleet.selectedNode!.agent} with a continuation…`
      : fleet.selectedNode!.attention
        ? `Reply to ${fleet.selectedNode!.agent}…`
        : `Steer ${fleet.selectedNode!.agent}…`}
    disabledReason={fleet.selectedLegacyAgent !== null
      ? "Inline agents are watch-only — steer them through the main chat."
      : undefined}
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
      ).catch(() => { })
    }}
    onStop={() => {
      const node = fleet.selectedNode
      if (node === null) return
      const legacy = fleet.legacyAgentFor(node)
      if (legacy !== null) {
        if (legacy.status === "working") convo.stopSubagent(legacy.id)
        return
      }
      controlSubagent(node, "stop").catch(() => { })
    }}
    followAgent={fileBrowser.followEnabled}
    onToggleFollowAgent={toggleFollowAgent}
    autoFocus={paneFocused}
    focusKey={fleet.selectedNode!.id} />
}

function renderMainConversation({
  convo,
  addLocalMcp,
  mcpServers,
  onSetMcpApiKey,
  onSetMcpAuth,
  onAuthorizeMcp,
  session,
  liveDiffs,
  environments,
  environmentMutation,
  setContinuationEnvironmentId,
  contextQuery,
  preparing,
  requested,
  digestReady,
  setRequested,
  activeChat,
  handoffQueued,
  handoffModel,
  providerCatalog,
  agentEndpointCatalog,
  composerDisabledReason,
  sendPrompt,
  onOpenPlanReview,
  onForkOntoBranchStable,
  onAdoptBranchStable,
  plannotatorDocument,
  draft,
  draftCodeReferences,
  paneFocused,
  fileBrowser,
  toggleFollowAgent,
  onRestore,
  onDelete
}: {
  convo: Conversation;
  addLocalMcp: ((name: string, entry: McpConfigEntry) => Promise<void>) | undefined;
  mcpServers: ReadonlyArray<McpServer>;
  onSetMcpApiKey: ((name: string, apiKey: string) => Promise<void>) | undefined;
  onSetMcpAuth: ((name: string, auth: McpRemoteAuth) => Promise<void>) | undefined;
  onAuthorizeMcp: ((name: string) => Promise<void>) | undefined;
  session: Session;
  liveDiffs: Record<string, LiveDiffStat>;
  environments: Parameters<typeof ConversationPane>[0]["environments"];
  environmentMutation: EnvironmentMutationView;
  setContinuationEnvironmentId: (value: string | undefined | null) => void;
  contextQuery: { data: Awaited<ReturnType<typeof rpc.contextState>> | undefined };
  preparing: boolean;
  requested: boolean;
  digestReady: boolean;
  setRequested: (value: boolean) => void;
  activeChat: Session["chats"][number];
  handoffQueued: (id: string) => void;
  handoffModel: string | null;
  providerCatalog: ProviderCatalog | null | undefined;
  agentEndpointCatalog: AgentEndpointCatalog | null | undefined;
  composerDisabledReason: string | undefined;
  sendPrompt: (text: string, images?: ReadonlyArray<{ readonly id: string; readonly name: string; readonly mediaType: string; readonly data: string }>, agentContext?: string) => void;
  onOpenPlanReview: ((stepId?: string) => void) | undefined;
  onForkOntoBranchStable: () => Promise<void>;
  onAdoptBranchStable: () => Promise<void>;
  plannotatorDocument: import("@jingler/core").PlanDocument | null;
  draft: Draft;
  draftCodeReferences: { path: string; startLine: number; endLine: number; label: string }[];
  paneFocused: boolean;
  fileBrowser: FileBrowserController;
  toggleFollowAgent: (enabled: boolean) => void;
  onRestore: ((sessionId: string) => void) | undefined;
  onDelete: ((sessionId: string) => void) | undefined;
}) {
  return <ConversationView
    messages={convo.messages}
    hasMoreHistory={convo.hasMoreHistory}
    loadingHistory={convo.loadingHistory}
    onLoadEarlier={convo.loadOlder}
    mode={convo.mode}
    skills={convo.skills}
    files={convo.files}
    onAddMcp={addLocalMcp}
    mcpServers={mcpServers}
    onSetMcpApiKey={onSetMcpApiKey}
    onSetMcpAuth={onSetMcpAuth}
    onAuthorizeMcp={onAuthorizeMcp}
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
    contextBreakdown={convo.contextBreakdown}
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
    handoffHint={handoffModel
      ? `Hand off — run this in a new chat on ${handoffModel}`
      : "Hand off — run this in a new chat"}
    providerCatalog={providerCatalog}
    agentEndpointCatalog={agentEndpointCatalog}
    endpointId={convo.endpointId}
    connectionId={convo.connectionId}
    providerId={convo.providerId}
    modelId={convo.modelId}
    composerDisabledReason={composerDisabledReason}
    onSetModel={({ runtimeId, endpointId, connectionId, providerId, modelId }) =>
      convo.setModel(runtimeId, endpointId, connectionId, providerId, modelId)}
    onSend={sendPrompt}
    onRetryPrompt={
      session.archived || composerDisabledReason !== undefined
        ? undefined
        : (convo.retryPrompt ?? undefined)
    }
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
    planDocument={plannotatorDocument}
    draft={draft.text}
    // Merge against the LIVE draft, never the render-time `draft` closure:
    // on send the composer fires onSend → setValue("") → setAttachments([])
    // in one go, so a stale spread would resurrect the text it just sent.
    onDraftChange={(text) => setDraft(activeChat.id, { ...getDraft(activeChat.id), text })}
    draftAttachments={draft.attachments}
    onDraftAttachmentsChange={(attachments) => setDraft(activeChat.id, { ...getDraft(activeChat.id), attachments })}
    draftCodeReferences={draftCodeReferences}
    onDraftCodeReferenceRemove={(index) => {
      const current = getDraft(activeChat.id)
      setDraft(activeChat.id, {
        ...current,
        references: current.references.filter((_, currentIndex) => currentIndex !== index)
      })
    }}
    onDraftCodeReferencesClear={() => setDraft(activeChat.id, { ...getDraft(activeChat.id), references: [] })}
    // The Plan face returns early above, so reaching here already means the
    // transcript is on screen — only the focused pane still has to be checked.
    autoFocusComposer={paneFocused}
    focusKey={activeChat.id}
    followAgent={fileBrowser.followEnabled}
    onToggleFollowAgent={toggleFollowAgent}
    archived={session.archived
      ? {
        reason: session.archiveReason ?? "merged",
        prNumber: session.prNumber,
        base: session.baseBranch,
        onRestore: () => onRestore?.(session.id),
        onDelete: () => onDelete?.(session.id)
      }
      : undefined} />
}

function conversationChatShortcut(closeChat: (chatId: string) => void, activeChat: Session["chats"][number], session: Session, selectChat: (chatId: string) => void) {
  return (event: KeyboardEvent) => {
    if (event.defaultPrevented) return
    if ((!event.metaKey && !event.ctrlKey) || event.altKey) return
    const target = event.target
    if (target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT")) return
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
}

type EnvironmentMutationView = {
  readonly error: Error | null
  readonly isPending: boolean
  readonly mutate: (environmentId: string | undefined) => void
  readonly reset: () => void
}

function renderEnvironmentNotices(
  {
    convo,
    continuationEnvironmentId,
    handoffAfterStop,
    continueEnvironmentMutation,
    environmentMutation,
    setHandoffAfterStop,
    setContinuationEnvironmentId
  }: {
    convo: Conversation;
    continuationEnvironmentId: string | undefined | null;
    handoffAfterStop: { environmentId: string | undefined } | null;
    continueEnvironmentMutation: EnvironmentMutationView;
    environmentMutation: EnvironmentMutationView;
    setHandoffAfterStop: (value: { environmentId: string | undefined } | null) => void;
    setContinuationEnvironmentId: (value: string | undefined | null) => void;
  }
) {
  return <>
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
  </>
}

function useFleetChildTranscript(session: Session, fleet: SubagentFleetController, chatId: string) {
  const childTranscriptQuery = useQuery({
    queryKey: [
      "subagent-transcript",
      session.id,
      chatId,
      fleet.selectedNode?.parentRuntimeSessionId,
      fleet.selectedNode?.runId
    ],
    queryFn: () => rpc.agentSubagentTranscript(
      session.id,
      chatId,
      fleet.selectedNode!.parentRuntimeSessionId,
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
  return childTranscriptQuery
}

function plannotatorReviewId(projection: Conversation["plannotator"]): string | null {
  return projection?.review?.reviewId ?? null
}

function conversationProviderRecovery(
  session: Session,
  convo: Conversation,
  providerCatalog: ProviderCatalog | undefined | null,
  endpointCatalog: AgentEndpointCatalog | undefined | null,
  environments: ReadonlyArray<Environment>
) {
  const nativeReady = convo.runtimeId !== "pi" && endpointCatalog?.endpoints.some(
    ({ endpoint, models }) =>
      endpoint.id === convo.endpointId &&
      endpoint.status === "ready" &&
      models.some((model) => model.id === convo.modelId && model.providerId === convo.providerId && model.selectable)
  ) === true
  if (nativeReady) {
    return { providerRecovery: undefined, rebindConnectionId: undefined, composerDisabledReason: undefined }
  }
  const providerSelection = {
    ...convo,
    connectionSelectionRequired: session.connectionSelectionRequired,
    modelSelectionRequired: session.modelSelectionRequired,
    targetId: runtimeTargetForSession(session, environments),
    target: environments.find((environment) => environment.id === session.environmentId)
  }
  const providerRecovery = providerCatalog
    ? providerRecoveryOf(providerCatalog, providerSelection)
    : undefined
  // Reconnecting a removed account mints a new connection id, so the pinned one
  // never reappears and the recovery card would stay up after the operator has
  // already fixed the problem. When the refreshed catalog has an unambiguous
  // replacement, rebind through the same SET_MODEL path the picker uses.
  const rebindConnectionId = providerCatalog
    ? providerRebindOf(providerCatalog, providerSelection)
    : undefined
  const composerDisabledReason = typeof providerRecovery === "string"
    ? providerRecovery
    : providerRecovery?.message
  return { providerRecovery, rebindConnectionId, composerDisabledReason }
}

function contextReadiness(context: Awaited<ReturnType<typeof rpc.contextState>> | undefined) {
  return { preparing: context?.preparing ?? false, digestReady: context?.digestReady ?? false }
}

function configuredFontScale(config: Awaited<ReturnType<typeof rpc.configGet>> | undefined): number {
  return clampFontScale(config?.fontScale)
}

function renderPlanSurface(
  plannotatorDocument: import("@jingler/core").PlanDocument | null,
  pendingReviewId: string | null,
  decideReview: (approved: boolean, feedback?: string) => Promise<void>
) {
  return plannotatorDocument !== null
    ? (
      <PlanReview
        key={`${plannotatorDocument.sessionId}:${plannotatorDocument.producingChatId}:${plannotatorDocument.id}:${pendingReviewId ?? "plan"}`}
        document={plannotatorDocument}
        canApprove={pendingReviewId !== null}
        onApprove={() => decideReview(true)}
        onRevise={(feedback) => decideReview(false, feedback)}
      />
    )
    : null
}
