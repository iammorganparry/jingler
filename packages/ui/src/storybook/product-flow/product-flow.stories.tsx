import type { Meta, StoryObj } from "@storybook/react-vite"
import type {
  ManagedResource,
  ManagedResourceId,
  ProviderConnectionId,
  ProviderModelId,
  Session
} from "@jingler/core"
import { useMachine } from "@xstate/react"
import { useState, type ReactNode } from "react"
import { JinglerApp } from "../../app/jingler-app.js"
import { ConversationView } from "../../app/conversation-view.js"
import { RuntimeRecoveryCard } from "../../composites/runtime-recovery-card.js"
import {
  SettingsView,
  type SettingsViewProps
} from "../../composites/settings-view.js"
import { LoginScreen } from "../../screens/login-screen.js"
import { SetupScreen } from "../../screens/setup-screen.js"
import { SEED_CONVERSATION } from "../../seed.js"
import {
  FLOW_ENVIRONMENTS,
  FLOW_GITHUB,
  FLOW_PROJECTS,
  FLOW_PROVIDER_CATALOG,
  FLOW_REPOS,
  FLOW_RESOURCE_DETECTION,
  FLOW_RESOURCES,
  FLOW_RUNTIME_DIAGNOSTIC,
  FLOW_SESSIONS
} from "./fixtures.js"
import {
  productFlowMachine,
  type ProductFlowCheckpoint
} from "./product-flow-machine.js"

const meta = {
  title: "Product Flow/Full App",
  parameters: { layout: "fullscreen" }
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const noop = () => {}

const STORY_USER = {
  id: "storybook-user",
  name: "Morgan Parry",
  email: "morgan@jingler.dev",
  image: null
}

const LIVE_ACTIVITY = {
  "session-pi-foundation": {
    kind: "needs-approval" as const,
    verb: "Waiting for approval",
    target: "pnpm test -- auth"
  }
}

const LIVE_DIFF = {
  "session-pi-foundation": { added: 428, removed: 117 },
  "session-cloud-review": { added: 73, removed: 21 }
}

const disconnectedGithub = {
  ...FLOW_GITHUB,
  mode: "disconnected" as const,
  connected: false,
  user: null,
  installations: []
}

const useProviderSettings = (): NonNullable<SettingsViewProps["providerConnections"]> => {
  const [defaultConnectionId, setDefaultConnectionId] = useState<ProviderConnectionId | null>(
    FLOW_PROVIDER_CATALOG.connections[0]?.connection.id ?? null
  )
  const [defaultModelId, setDefaultModelId] = useState<ProviderModelId | null>(
    FLOW_PROVIDER_CATALOG.connections[0]?.models[0]?.id ?? null
  )

  return {
    catalog: FLOW_PROVIDER_CATALOG,
    defaultConnectionId,
    defaultModelId,
    onRefresh: noop,
    onVerify: noop,
    onMakeDefault: ({ connectionId, modelId }) => {
      setDefaultConnectionId(connectionId)
      setDefaultModelId(modelId)
    },
    onLogout: noop,
    onConnectClaude: noop,
    onStartCodex: noop,
    onSetApiKey: noop
  }
}

const useAgentSettings = (
  reviewing = false
): NonNullable<SettingsViewProps["agents"]> => {
  const [resources, setResources] = useState<ReadonlyArray<ManagedResource>>(FLOW_RESOURCES)
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<ReadonlySet<string>>(
    () => new Set(FLOW_RESOURCE_DETECTION.candidates.map(({ id }) => id))
  )

  return {
    resources,
    detection: FLOW_RESOURCE_DETECTION,
    selectedCandidateIds,
    loading: false,
    reviewing,
    onDetect: noop,
    onToggleCandidate: (id) => {
      setSelectedCandidateIds((selected) => {
        const next = new Set(selected)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    },
    onImportSelected: noop,
    onCancelDetection: noop,
    onSetEnabled: (id: ManagedResourceId, enabled: boolean) => {
      setResources((current) =>
        current.map((resource) => resource.id === id ? { ...resource, enabled } : resource)
      )
    },
    onReveal: noop,
    onRemove: (id: ManagedResourceId) => {
      setResources((current) => current.filter((resource) => resource.id !== id))
    },
    onRetry: noop
  }
}

const useRuntimeInspector = (): NonNullable<SettingsViewProps["runtimeInspector"]> => {
  const [exported, setExported] = useState(false)
  return {
    snapshot: FLOW_RUNTIME_DIAGNOSTIC,
    loading: false,
    exported,
    onRefresh: noop,
    onExport: () => setExported(true)
  }
}

const useMockSessions = () => {
  const [sessions, setSessions] = useState<ReadonlyArray<Session>>(FLOW_SESSIONS)
  const update = (id: string, change: Partial<Session>) => {
    setSessions((current) =>
      current.map((session) => session.id === id ? { ...session, ...change } : session)
    )
  }

  return {
    sessions,
    rename: (id: string, title: string) => update(id, { title }),
    archive: (id: string) => update(id, {
      archived: true,
      archivedAt: new Date().toISOString()
    }),
    restore: (id: string) => update(id, {
      archived: false,
      archivedAt: undefined
    }),
    remove: (id: string) => {
      setSessions((current) => current.filter((session) => session.id !== id))
    }
  }
}

const MockConversation = ({
  session,
  onOpenPlanReview
}: {
  readonly session: Session
  readonly onOpenPlanReview: (stepId?: string) => void
}) => (
  <ConversationView
    messages={SEED_CONVERSATION}
    mode={session.mode ?? "ask"}
    branch={session.branch}
    repo={session.repo}
    environments={FLOW_ENVIRONMENTS}
    environmentId={session.environmentId}
    providerCatalog={FLOW_PROVIDER_CATALOG}
    connectionId={session.connectionId}
    providerId={session.providerId}
    modelId={session.modelId}
    tokens={session.contextTokens ?? session.tokens}
    contextTriggerAt={800_000}
    onSetModel={noop}
    onSend={noop}
    onSetMode={noop}
    onDecideGate={noop}
    onOpenPlanReview={onOpenPlanReview}
  />
)

function MockProductApp() {
  const sessionState = useMockSessions()
  const providerConnections = useProviderSettings()
  const agents = useAgentSettings()
  const runtimeInspector = useRuntimeInspector()

  return (
    <JinglerApp
      sessions={sessionState.sessions}
      activeSessionId={sessionState.sessions[0]?.id}
      repos={FLOW_REPOS}
      projects={FLOW_PROJECTS}
      environments={FLOW_ENVIRONMENTS}
      githubConnection={FLOW_GITHUB}
      user={STORY_USER}
      version="2.1.0-storybook"
      liveActivity={LIVE_ACTIVITY}
      liveDiff={LIVE_DIFF}
      providerConnections={providerConnections}
      agents={agents}
      runtimeInspector={runtimeInspector}
      planSessions={new Set(["session-pi-foundation"])}
      loadBranches={async () => ["main", "feat/pi-foundation", "release/2.1"]}
      onRenameSession={sessionState.rename}
      onArchiveSession={sessionState.archive}
      onRestoreSession={sessionState.restore}
      onDeleteSession={sessionState.remove}
      renderConversation={(session, _view, context) => (
        <MockConversation session={session} onOpenPlanReview={context.onOpenPlanReview} />
      )}
    />
  )
}

function ProductFlow({ startAt }: { readonly startAt: ProductFlowCheckpoint }) {
  const [snapshot, send] = useMachine(productFlowMachine, { input: { startAt } })
  const github = snapshot.context.githubConnected ? FLOW_GITHUB : disconnectedGithub
  const catalog = snapshot.context.providerConnected ? FLOW_PROVIDER_CATALOG : null

  if (snapshot.matches("auth")) {
    return (
      <LoginScreen
        onGithub={() => send({ type: "AUTHENTICATE" })}
        onGoogle={() => send({ type: "AUTHENTICATE" })}
        onSendMagicLink={() => send({ type: "AUTHENTICATE" })}
        onReset={noop}
      />
    )
  }

  if (snapshot.matches("app")) return <MockProductApp />

  const step = snapshot.matches("providerConnecting")
    ? "provider"
    : snapshot.value as "workspace" | "github" | "provider" | "resources"
  return (
    <SetupScreen
      step={step}
      github={github}
      repos={FLOW_REPOS}
      reposDir={snapshot.context.workspaceChosen ? "/Users/morgan/Code" : null}
      providerCatalog={catalog}
      providerPendingAuthKind={snapshot.context.providerPendingAuthKind}
      busy={snapshot.matches("providerConnecting")}
      resourceDetection={FLOW_RESOURCE_DETECTION}
      onChooseDir={() => send({ type: "CHOOSE_WORKSPACE" })}
      onContinue={() => send({ type: "CONTINUE" })}
      onConnectGithub={() => send({ type: "CONNECT_GITHUB" })}
      onSkipGithub={() => send({ type: "SKIP_GITHUB" })}
      onConnectClaude={() => send({
        type: "CONNECT_PROVIDER",
        authKind: "claude-setup-token"
      })}
      onStartCodex={() => send({
        type: "CONNECT_PROVIDER",
        authKind: "openai-codex-oauth"
      })}
      onConnectApi={() => send({
        type: "CONNECT_PROVIDER",
        authKind: "api-key"
      })}
      onContinueProvider={() => send({ type: "CONTINUE" })}
      onSkipProvider={() => send({ type: "SKIP_PROVIDER" })}
      onCancelAuth={noop}
      onRetryProvider={noop}
      onImportResources={() => send({ type: "IMPORT_RESOURCES" })}
      onSkipResources={() => send({ type: "SKIP_RESOURCES" })}
      onCancelResourceImport={noop}
      onRetryResources={noop}
    />
  )
}

function SettingsCheckpoint({
  initialSection,
  reviewing = false
}: {
  readonly initialSection: NonNullable<SettingsViewProps["initialSection"]>
  readonly reviewing?: boolean
}) {
  const providerConnections = useProviderSettings()
  const agents = useAgentSettings(reviewing)
  const runtimeInspector = useRuntimeInspector()

  return (
    <SettingsView
      initialSection={initialSection}
      githubConnection={FLOW_GITHUB}
      providerConnections={providerConnections}
      agents={agents}
      runtimeInspector={runtimeInspector}
    />
  )
}

const frame = (node: ReactNode) => <div className="h-screen w-full">{node}</div>

/** Click through sign-in, workspace, GitHub, provider auth, resource import, and the app. */
export const CompleteJourney: Story = {
  render: () => frame(<ProductFlow startAt="auth" />)
}

export const ProviderOnboarding: Story = {
  render: () => frame(<ProductFlow startAt="provider" />)
}

export const ResourceImport: Story = {
  render: () => frame(<ProductFlow startAt="resources" />)
}

export const ActivePiSession: Story = {
  render: () => frame(<MockProductApp />)
}

export const ProviderSettings: Story = {
  render: () => frame(<SettingsCheckpoint initialSection="providers" />)
}

export const AgentResources: Story = {
  render: () => frame(<SettingsCheckpoint initialSection="agents" reviewing />)
}

export const RuntimeInspector: Story = {
  render: () => frame(<SettingsCheckpoint initialSection="runtime" />)
}

export const MutationRecovery: Story = {
  render: () => frame(
    <div className="flex h-full items-center bg-editor p-8">
      <div className="w-full overflow-hidden rounded-lg border border-line bg-panel">
        <RuntimeRecoveryCard
          title="Mutation state needs review"
          message="The provider disconnected after a write began. Jingler will not retry or switch billing routes until you inspect the actual workspace state."
          detail="workspace_write · 4 files reconciled · retry blocked"
          actionLabel="Resume safely"
          onAction={noop}
          onInspect={noop}
        />
      </div>
    </div>
  )
}
