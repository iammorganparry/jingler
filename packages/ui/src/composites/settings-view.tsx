import * as React from "react"
import type {
  AgentEndpointCatalog,
  GitHubConnection,
  GitConfig,
  GithubConfig,
  NotificationPermission,
  NotificationsConfig,
  ObsidianExplanationsConfig,
  OffloadComputeSettings,
  ContextConfig,
  ContextSnapshot,
  Environment,
  ExecutionMode,
  Session,
  PlanTemplateConfig
} from "@jingler/core"
import {
  BUDGET_RANGE,
  DEFAULT_CONTEXT_CONFIG,
  NOTIFICATIONS_DEFAULT,
  OBSIDIAN_EXPLANATIONS_DEFAULT,
  clampFontScale
} from "@jingler/core"
import { ContextMeter } from "./context-meter.js"
import {
  ProviderConnectionsSettings,
  type ProviderConnectionsSettingsProps
} from "./provider-connections-settings.js"
import {
  Bell,
  Boxes,
  Cloud,
  Cpu,
  Keyboard,
  FolderCog,
  Palette,
  PanelTop,
  Plug,
  RefreshCw,
  Server,
  ShieldCheck,
  Gauge,
  Mic,
  SlidersHorizontal,
  Sparkles,
  TriangleAlert,
  X
} from "lucide-react"
import { cn } from "../lib/cn.js"
import { atLeast, useWidthTier } from "../hooks/width-tier.js"
import { Button } from "../components/button.js"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/beui/select.js"
import { Callout } from "../components/callout.js"
import { BannerShell } from "../components/banner-shell.js"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../components/dialog.js"
import { SearchField } from "../components/search-input.js"
import { Badge } from "../components/badge.js"
import { EmptyState } from "../components/feedback.js"
import { JinglerWordmark } from "../brand/jingler-mark.js"
import { AsyncButton } from "../components/async-button.js"
import { GithubMark } from "../components/github-mark.js"
import { HeaderViewsSettings, type HeaderViewsSettingsProps } from "./header-views-settings.js"
import { UsageSettings, type UsageSettingsProps } from "./usage-settings.js"
import { ThemesSettings, type ThemesSettingsProps } from "./themes-settings.js"
import {
  PluginsSettings,
  type PluginsSettingsProps
} from "./plugins-settings.js"
import { SegmentedControl } from "../components/segmented-control.js"
import { StatusDot } from "../components/status-dot.js"
import { Toggle } from "../components/toggle.js"
import { Spinner } from "../components/loading.js"
import { Field } from "../components/field.js"
import { Textarea } from "../components/textarea.js"
import { SettingsCard, SettingsRow } from "../components/settings-row.js"
import { ConfirmDialog } from "../components/confirm-dialog.js"
import { VoiceSettings, type VoiceSettingsProps } from "./voice-settings.js"
import { McpSettings, type McpSettingsProps } from "./mcp-settings.js"
import { Input } from "../components/input.js"
import { PairingSheet, type PairingSheetProps } from "./pairing-sheet.js"
import { AgentsSettings, type AgentsSettingsProps } from "./agents-settings.js"
import { RuntimeInspector, type RuntimeInspectorProps } from "./runtime-inspector.js"
import {
  WebSearchSettings,
  type WebSearchSettingsProps
} from "./web-search-settings.js"
import { ProviderModelBrowser } from "./provider-model-browser.js"
import { ProjectWorkflowSettings, type ProjectWorkflowSettingsProps } from "./project-workflow-settings.js"

// ── Section registry ─────────────────────────────────────────────────────────

type SectionKey =
  | "general"
  | "notifications"
  | "voice"
  | "projects"
  | "routines"
  | "providers"
  | "context"
  | "plan"
  | "agents"
  | "runtime"
  | "permissions"
  | "connectors"
  | "github"
  | "themes"
  | "headerViews"
  | "usage"
  | "plugins"
  | "keybindings"
  | "devices"

interface NavItem {
  key: SectionKey
  label: string
  icon: React.ReactNode
  /** Built sections; the rest render an informative stub. */
  ready: boolean
}

// ── Grouped nav structure per §5e ──────────────────────────────────────────

interface NavGroup {
  label: string
  items: ReadonlyArray<NavItem>
}

const NAV_GROUPS: ReadonlyArray<NavGroup> = [
  {
    label: "Workspace",
    items: [
      { key: "general", label: "General", icon: <SlidersHorizontal size={14} />, ready: true },
      { key: "notifications", label: "Notifications", icon: <Bell size={14} />, ready: true },
      { key: "voice", label: "Voice", icon: <Mic size={14} />, ready: true },
      { key: "projects", label: "Projects", icon: <FolderCog size={14} />, ready: true },
      { key: "usage", label: "Usage", icon: <Gauge size={14} />, ready: true },
      { key: "permissions", label: "Permissions", icon: <ShieldCheck size={14} />, ready: false }
    ]
  },
  {
    label: "Agents",
    items: [
      { key: "providers", label: "Providers", icon: <Cpu size={14} />, ready: true },
      { key: "agents", label: "Agents & skills", icon: <Sparkles size={14} />, ready: true },
      { key: "context", label: "Context", icon: <Gauge size={14} />, ready: true },
      { key: "plan", label: "Plan", icon: <Sparkles size={14} />, ready: true },
      { key: "runtime", label: "Runtime", icon: <Gauge size={14} />, ready: true }
    ]
  },
  {
    label: "Integrations",
    items: [
      { key: "github", label: "GitHub", icon: <GithubMark size={14} />, ready: true },
      { key: "connectors", label: "MCP servers", icon: <Plug size={14} />, ready: true },
      { key: "plugins", label: "Plugins", icon: <Boxes size={14} />, ready: true },
      { key: "devices", label: "Devices", icon: <Server size={14} />, ready: true }
    ]
  },
  {
    label: "Appearance",
    items: [
      { key: "themes", label: "Themes", icon: <Palette size={14} />, ready: true },
      { key: "headerViews", label: "Header views", icon: <PanelTop size={14} />, ready: true },
      { key: "keybindings", label: "Keybindings", icon: <Keyboard size={14} />, ready: false }
    ]
  }
]

const NAV: ReadonlyArray<NavItem> = NAV_GROUPS.flatMap(g => g.items)

export interface SettingsViewProps {
  routines?: (projectId: string, templates?: ReadonlyArray<import("@jingler/core").ProjectRoutineTemplate>) => import("react").ReactNode
  projectWorkflows?: ProjectWorkflowSettingsProps
  /** Canonical provider connections. When present, legacy CLI cards stay hidden. */
  providerConnections?: ProviderConnectionsSettingsProps
  /** Operator-controlled skills, prompts, and MCP resources. */
  agents?: AgentsSettingsProps
  /** Redacted WebSearch status and write-only credential actions. */
  webSearch?: WebSearchSettingsProps
  /** Redacted metadata for the latest embedded pi run. */
  runtimeInspector?: RuntimeInspectorProps
  /**
   * Everything the Themes pane needs. Optional so Storybook and the component
   * gallery can mount Settings without standing up a theme catalog; absent
   * renders the stub, exactly as an unbuilt section does.
   */
  themes?: ThemesSettingsProps
  /** Pin toggles for the session header views; absent renders the stub. */
  headerViews?: HeaderViewsSettingsProps
  /** Full Usage page; absent renders the stub. */
  usage?: UsageSettingsProps
  /**
   * Everything the Plugins pane needs. Optional for the same reason `themes`
   * is — Storybook mounts Settings without a plugin catalog, and absent renders
   * the stub rather than an empty screen pretending nothing is installed.
   */
  plugins?: PluginsSettingsProps
  devices?: {
    environments: ReadonlyArray<Environment>
    loading: boolean
    error?: string | null
    dialog: PairingSheetProps
    /** Live workspaces; those on a device are listed before it can be revoked. */
    workspaces?: ReadonlyArray<Pick<Session, "id" | "title" | "environmentId">>
    onOpen: () => void
    onRefresh: () => void | Promise<void>
    onRename: (id: string, name: string) => void | Promise<void>
    onRevoke: (id: string) => void | Promise<void>
  }
  /** MCP servers from ~/jingler/mcp.json (from `useMcpSettings`). */
  mcp?: McpSettingsProps
  /** Local speech-to-text models, language and hold-to-talk key. */
  voice?: VoiceSettingsProps
  /** Auto-compaction levers (master switch + working-set budget). */
  context?: ContextConfig | null
  onSaveContext?: (config: ContextConfig) => void
  /**
   * Live context readings per open session, so the budget slider can be set
   * against what sessions are ACTUALLY using rather than in the abstract.
   */
  contextSessions?: ReadonlyArray<{
    id: string
    title: string
    snapshot: ContextSnapshot
  }>
  // Shared GitHub App connection (separate from BetterAuth social sign-in).
  githubConnection: GitHubConnection
  githubBusy?: boolean
  onGithubConnect?: () => void
  onGithubManage?: () => void
  onGithubRefresh?: () => void
  onGithubDisconnect?: () => void
  github?: GithubConfig | null
  /** Desktop harnesses and models available to the adversarial reviewer. */
  agentEndpointCatalog?: AgentEndpointCatalog | null
  git?: GitConfig | null
  onSaveGithub?: (config: GithubConfig) => void
  onSaveGit?: (config: GitConfig) => void
  /** Obsidian explanation auto-save; absent means the default (off). */
  obsidianExplanations?: ObsidianExplanationsConfig | null
  onSaveObsidianExplanations?: (config: ObsidianExplanationsConfig) => void | Promise<void>
  /** Whether any session has an Obsidian vault configured; hides the setting otherwise. */
  obsidianVaultConfigured?: boolean
  /** Desktop-notification prefs; absent means the defaults, not "off". */
  notifications?: NotificationsConfig | null
  onSaveNotifications?: (config: NotificationsConfig) => void | Promise<void>
  /**
   * Can the OS show Jingler's notifications? Only "denied" is actionable here —
   * main never emits it today (see `notificationPermission` in
   * apps/desktop/src/main/notifications.ts), so the warning row stays dark
   * until a real macOS probe exists.
   */
  notificationPermission?: NotificationPermission | null
  /** Opens System Settings → Notifications; macOS only. */
  onOpenNotificationSystemSettings?: () => void | Promise<void>
  /** Automatic read-only cloud routing for eligible agent commands. */
  offloadCompute?: OffloadComputeSettings | null
  onSaveOffloadCompute?: (settings: OffloadComputeSettings) => void | Promise<void>
  offloadStatus?: "disabled" | "priming" | "ready" | "failed"
  /** Re-run Offload Compute priming after a failed save. */
  onRetryOffload?: () => void
  /** Permission mode used for new chats across every provider model. */
  defaultMode?: ExecutionMode | null
  onSaveDefaultMode?: (defaultMode: ExecutionMode) => void | Promise<void>
  /** Whether plan mode runs commands unattended; absent means on. */
  planAutoRun?: boolean | null
  onSavePlanAutoRun?: (planAutoRun: boolean) => void | Promise<void>
  /** Custom starting plan structure; absent or empty means the built-in draft. */
  planTemplate?: PlanTemplateConfig | null
  onSavePlanTemplate?: (template: PlanTemplateConfig) => void | Promise<void>
  /** Whether final completion summaries are shaped for an ADHD reader. */
  adhdMode?: boolean | null
  onSaveAdhdMode?: (adhdMode: boolean) => void | Promise<void>
  /** Multiplier for conversation + code text size; absent means 1×. */
  fontScale?: number | null
  onSaveFontScale?: (fontScale: number) => void | Promise<void>
  /** Close the view and return to the active session. */
  onClose?: () => void
  /** Recovery actions open directly on GitHub; ordinary Settings opens Providers. */
  initialSection?: SectionKey
}

/**
 * The dedicated Settings view (design E10) — a three-column shell: a section
 * nav, a provider list, and the selected provider's detail pane. Providers and
 * GitHub are functional; the other nav entries render a "coming soon" stub. It
 * fills the main pane (the sidebar stays), replacing the old modal.
 */
function renderOptionalSection<Props extends object>(
  props: Props | null | undefined,
  render: (props: Props) => React.ReactNode,
  label: string
): React.ReactNode {
  return props ? render(props) : <StubSection label={label} />
}

export function SettingsView({
  projectWorkflows,
  routines,
  providerConnections,
  agents,
  webSearch,
  runtimeInspector,
  themes,
  headerViews,
  usage,
  plugins,
  devices,
  mcp,
  voice,
  context,
  onSaveContext,
  contextSessions,
  githubConnection,
  githubBusy,
  onGithubConnect,
  onGithubManage,
  onGithubRefresh,
  onGithubDisconnect,
  github,
  agentEndpointCatalog,
  git,
  onSaveGithub,
  onSaveGit,
  obsidianExplanations,
  onSaveObsidianExplanations,
  obsidianVaultConfigured,
  notifications,
  onSaveNotifications,
  notificationPermission,
  onOpenNotificationSystemSettings,
  offloadCompute,
  onSaveOffloadCompute,
  offloadStatus,
  onRetryOffload,
  defaultMode,
  onSaveDefaultMode,
  planAutoRun,
  onSavePlanAutoRun,
  planTemplate,
  onSavePlanTemplate,
  adhdMode,
  onSaveAdhdMode,
  fontScale,
  onSaveFontScale,
  onClose,
  initialSection = "providers"
}: SettingsViewProps) {
         /** Sections that render their props or a stub; split out to keep getSection under the complexity gate. */
         function getOptionalSection(): React.ReactNode | undefined {
           switch (section) {
case "devices": {
return (renderOptionalSection(devices, (props) => <DevicesSection {...props} />, "Devices"))
}
case "voice": {
return renderOptionalSection(voice, (props) => <VoiceSettings {...props} />, "Voice")
}
case "providers": {
return (renderOptionalSection(providerConnections, (props) => <ProviderConnectionsSettings {...props} />, "Providers"))
}
case "agents": {
return (renderOptionalSection(agents, (props) => <AgentsSettings {...props} />, "Agents & skills"))
}
case "runtime": {
return (renderOptionalSection(runtimeInspector, (props) => <RuntimeInspector {...props} />, "Runtime"))
}
case "plugins": {
return (renderOptionalSection(plugins, (props) => <PluginsSettings {...props} />, "Plugins"))
}
case "headerViews": {
return renderOptionalSection(headerViews, (props) => <HeaderViewsSettings {...props} />, "Header views")
}
case "usage": {
return renderOptionalSection(usage, (props) => <UsageSettings {...props} />, "Usage")
}
case "themes": {
return (renderOptionalSection(themes, (props) => <ThemesSettings {...props} />, "Themes"))
}
           }
           return undefined
         }

         function getSection() {
           const optional = getOptionalSection()
           if (optional !== undefined) return optional
           switch (section) {
case "routines":
case "projects": {
return renderOptionalSection(projectWorkflows, (props) => <ProjectWorkflowSettings {...props} routines={routines} />, "Projects")
}
case "notifications": {
return (<NotificationsSection
          notifications={notifications}
          onSaveNotifications={onSaveNotifications}
          permission={notificationPermission}
          onOpenSystemSettings={onOpenNotificationSystemSettings}
        />)
}
case "general": {
return (<GeneralSection
          obsidianExplanations={obsidianExplanations}
          onSaveObsidianExplanations={onSaveObsidianExplanations}
          obsidianVaultConfigured={obsidianVaultConfigured}
          offloadCompute={offloadCompute}
          onSaveOffloadCompute={onSaveOffloadCompute}
          offloadStatus={offloadStatus}
          onRetryOffload={onRetryOffload}
          offloadEnvironments={devices?.environments.filter((environment) =>
            environment.kind === "owned"
          ) ?? []}
          onRefreshOffloadEnvironments={devices?.onRefresh}
          defaultMode={defaultMode}
          onSaveDefaultMode={onSaveDefaultMode}
          adhdMode={adhdMode}
          onSaveAdhdMode={onSaveAdhdMode}
          fontScale={fontScale}
          onSaveFontScale={onSaveFontScale}
          webSearch={webSearch}
        />)
}
case "context": {
return (<ContextSection
          context={context}
          sessions={contextSessions}
          onSaveContext={onSaveContext}
        />)
}
case "plan": {
return (<PlanSection
          planAutoRun={planAutoRun}
          onSavePlanAutoRun={onSavePlanAutoRun}
          planTemplate={planTemplate}
          onSavePlanTemplate={onSavePlanTemplate}
        />)
}
case "connectors": {
return (<div className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-editor p-8">
          {renderOptionalSection(mcp, (props) => <McpSettings {...props} />, "MCP servers")}
        </div>)
}
case "github": {
return (<GithubSection
          connection={githubConnection}
          busy={githubBusy}
          github={github}
          git={git}
          onConnect={onGithubConnect}
          onManage={onGithubManage}
          onRefresh={onGithubRefresh}
          onDisconnect={onGithubDisconnect}
          agentEndpointCatalog={agentEndpointCatalog}
          onSaveGithub={onSaveGithub}
          onSaveGit={onSaveGit}
        />)
}
}
           return (<StubSection
          label={NAV.find((n) => n.key === section)?.label ?? "Settings"}
        />)
         }

  const [section, setSection] = React.useState<SectionKey>(initialSection)
  const [searchQuery, setSearchQuery] = React.useState("")
  const selectSection = (next: SectionKey) => {
    setSection(next)
    if (next === "providers") providerConnections?.onReload?.()
    if (next === "runtime") runtimeInspector?.onRefresh()
    if (next === "usage") usage?.onOpen?.()
  }

  // Three `flex-none` columns (216 + 328 + detail) is ~544px of chrome before
  // the settings themselves get a pixel. Below `mid` the nav narrows to an icon
  // rail so the section you're editing keeps the room.
  const compact = !atLeast(useWidthTier(), "wide")

  return (
    <div className="flex min-h-0 flex-1 bg-editor">
      {/* nav */}
      <nav
        className={cn(
          "flex flex-none flex-col gap-0.5 border-r border-hairline bg-panel p-2.5",
          compact ? "w-[56px] items-center" : "w-[220px]"
        )}
      >
        <div
          className={cn(
            "flex items-center px-2.5 pb-1.5 pt-1",
            compact ? "justify-center" : "justify-between"
          )}
        >
          {!compact && <JinglerWordmark className="text-[13px]" />}
          {onClose && (
            <button
              type="button"
              aria-label="Close settings"
              onClick={onClose}
              className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-surface hover:text-text"
            >
              <X size={13} />
            </button>
          )}
        </div>
        
        {/* Search */}
        {!compact && (
          <div className="px-1 pb-2">
            <SearchField
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search settings"
              aria-label="Search settings"
            />
          </div>
        )}

        {/* Grouped nav items */}
        {NAV_GROUPS.map((group) => {
          const visibleItems = group.items.filter(item => 
            !searchQuery || item.label.toLowerCase().includes(searchQuery.toLowerCase())
          )
          if (visibleItems.length === 0) return null
          
          return (
            <div key={group.label} className={cn("flex flex-col gap-0.5", compact && "items-center")}>
              {!compact && (
                <div className="px-2.5 pb-1 pt-2 text-[11px] font-semibold text-text-dim">
                  {group.label}
                </div>
              )}
              {visibleItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => selectSection(item.key)}
                  aria-current={section === item.key}
                  aria-label={item.label}
                  title={item.label}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md py-2 text-[13px] transition-colors",
                    compact ? "justify-center px-2" : "px-2.5",
                    section === item.key
                      ? "bg-surface font-medium text-text-bright"
                      : "text-muted-foreground hover:bg-hover"
                  )}
                >
                  <span
                    className={cn(
                      section === item.key ? "text-text-bright" : "text-muted-foreground"
                    )}
                  >
                    {item.icon}
                  </span>
                  {!compact && (
                    <>
                      <span className="flex-1 text-left">{item.label}</span>
                      {!item.ready && <Badge tone="count">Soon</Badge>}
                      {item.key === "providers" && (
                        <span className="rounded bg-hover px-1.5 py-px font-mono text-[9px] text-muted-foreground">
                          {providerConnections?.catalog?.connections.length ?? 0}
                        </span>
                      )}
                    </>
                  )}
                </button>
              ))}
            </div>
          )
        })}
        
        {!compact && (
          <div className="mt-auto rounded-md border border-line px-2.5 py-2 font-mono text-[10px] leading-relaxed text-dim">
            config ·{" "}
            <span className="text-muted-foreground">~/jingler/config.json</span>
            <br />
            user scope
          </div>
        )}
      </nav>

      {getSection()}
    </div>
  )
}

/** From apps/device-agent/README.md "Build and bootstrap". */
const DEVICE_AGENT_UPDATE_COMMAND = "pnpm --filter @jingler/device-agent build"

const DEVICE_STATUS_LABEL: Record<Environment["state"], string> = {
  online: "Online",
  offline: "Offline",
  reconnecting: "Reconnecting…",
  incompatible: "Incompatible",
  revoked: "Revoked",
  provisioning: "Provisioning…",
  sleeping: "Sleeping",
  restoring: "Restoring…",
  paused: "Paused",
  failed: "Failed"
}

const agentTooOldText = (agentVersion: string | null): string =>
  agentVersion
    ? `Device agent v${agentVersion.replace(/^v/, "")} is older than this app needs`
    : "Device agent is older than this app needs"

/** One neutral line of text; only Incompatible carries a (red) icon, never a fill. */
function DeviceStatus({ state }: { state: Environment["state"] }) {
  return (
    <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
      {state === "incompatible" && (
        <TriangleAlert size={12} className="text-state-failed" aria-hidden />
      )}
      {DEVICE_STATUS_LABEL[state]}
    </span>
  )
}

function RevokeImpact({
  workspaces
}: {
  workspaces: ReadonlyArray<{ id: string; title: string }>
}) {
  const count = workspaces.length
  if (count === 0) return <p>No workspaces run on it.</p>
  return (
    <>
      <p>
        {count} {count === 1 ? "workspace runs" : "workspaces run"} on it and
        will stop.
      </p>
      <ul className="mt-2 list-disc pl-5">
        {workspaces.map((workspace) => (
          <li key={workspace.id}>{workspace.title}</li>
        ))}
      </ul>
    </>
  )
}

export function DevicesSection({
  environments,
  loading,
  error,
  dialog,
  workspaces = [],
  onOpen,
  onRefresh,
  onRename,
  onRevoke
}: NonNullable<SettingsViewProps["devices"]>) {
  const [renameTarget, setRenameTarget] = React.useState<Environment | null>(
    null
  )
  const [renameValue, setRenameValue] = React.useState("")
  const [renamePending, setRenamePending] = React.useState(false)
  const [revokeTarget, setRevokeTarget] = React.useState<Environment | null>(
    null
  )
  const [updateOpen, setUpdateOpen] = React.useState(false)
  const revokeWorkspaces = workspaces.filter(
    (workspace) => revokeTarget && workspace.environmentId === revokeTarget.id
  )

  const openRename = (environment: Environment): void => {
    setRenameTarget(environment)
    setRenameValue(environment.name)
  }

  const closeRename = (): void => {
    if (renamePending) return
    setRenameTarget(null)
  }

  const submitRename = async (): Promise<void> => {
    if (!(renameTarget && renameValue.trim()) || renamePending) return
    setRenamePending(true)
    try {
      await onRename(renameTarget.id, renameValue.trim())
      setRenameTarget(null)
    } finally {
      setRenamePending(false)
    }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-editor p-6">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[20px] font-semibold text-text-bright">
              Devices
            </h2>
            <p className="mt-1 text-[12px] text-muted-foreground">
              {environments.some((environment) => environment.kind === "managed")
                ? "Cloud is ready on demand. Account-owned machines appear here automatically after SSH setup."
                : "Your account-owned machines appear here automatically after SSH setup."}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void onRefresh()}
              disabled={loading}
            >
              <RefreshCw size={13} /> Refresh
            </Button>
            <Button size="sm" onClick={onOpen}>
              Add owned machine
            </Button>
          </div>
        </div>
        {error && (
          <div
            role="alert"
            className="rounded-md border border-red/50 bg-red/10 px-3 py-2 text-[12px] text-red"
          >
            {error}
          </div>
        )}
        <div className="overflow-hidden rounded-lg border border-line bg-panel">
          {environments.length === 0 ? (
            loading ? (
              <div className="px-4 py-10 text-center text-[12px] text-muted-foreground">
                Loading devices…
              </div>
            ) : (
              <EmptyState
                title="No owned machines yet"
                action={
                  <Button size="sm" onClick={onOpen}>
                    Pair a machine
                  </Button>
                }
              />
            )
          ) : (
            environments.map((environment) => (
              <div
                key={environment.id}
                className="flex items-center gap-3 border-b border-hairline px-4 py-3 last:border-b-0"
              >
                <span className="flex size-9 items-center justify-center rounded-md bg-sunken text-blue">
                  {environment.kind === "managed" ? (
                    <Cloud size={17} />
                  ) : (
                    <Server size={17} />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <strong className="block truncate text-[12px] text-text-bright">
                    {environment.name}
                  </strong>
                  <span className="text-[10px] text-muted-foreground">
                    {environment.platform.os} · {environment.platform.arch} ·{" "}
                    {environment.kind === "managed"
                      ? "sandbox starts automatically per session"
                      : environment.agentVersion
                        ? `agent ${environment.agentVersion}`
                        : "agent version unknown"}
                  </span>
                  {environment.state === "incompatible" && (
                    <div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                      {agentTooOldText(environment.agentVersion)}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setUpdateOpen(true)}
                      >
                        How to update
                      </Button>
                    </div>
                  )}
                </div>
                <DeviceStatus state={environment.state} />
                {environment.kind === "owned" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openRename(environment)}
                  >
                    Rename
                  </Button>
                )}
                {environment.kind === "owned" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRevokeTarget(environment)}
                  >
                    Revoke
                  </Button>
                )}
              </div>
            ))
          )}
        </div>
      </div>
      <PairingSheet {...dialog} />
      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null)
        }}
        title={`Revoke ${revokeTarget?.name ?? ""}?`}
        description={<RevokeImpact workspaces={revokeWorkspaces} />}
        confirmLabel="Revoke device"
        destructive
        onConfirm={() => (revokeTarget ? onRevoke(revokeTarget.id) : undefined)}
      />
      <Dialog open={updateOpen} onOpenChange={setUpdateOpen}>
        <DialogContent className="w-[460px]">
          <DialogHeader>
            <DialogTitle>Update the device agent</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className="mb-2 text-[12px] text-muted-foreground">
              Build the current agent, then use Add owned machine to upload it
              over SSH.
            </p>
            <code className="block rounded-md bg-sunken px-3 py-2 font-mono text-[11px] text-text-bright">
              {DEVICE_AGENT_UPDATE_COMMAND}
            </code>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setUpdateOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) closeRename()
        }}
      >
        <DialogContent className="w-[420px]">
          <DialogHeader>
            <DialogTitle>Rename environment</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <Field label="Name">
              {(c) => (
                <Input
                  {...c}
                  aria-label="Environment name"
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void submitRename()
                  }}
                  disabled={renamePending}
                />
              )}
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={closeRename}
              disabled={renamePending}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void submitRename()}
              disabled={!renameValue.trim() || renamePending}
            >
              {renamePending ? "Renaming…" : "Rename"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function StubSection({ label }: { label: string }) {
  return (
    <section aria-label={label} className="flex flex-1 items-center justify-center bg-editor">
      <EmptyState title={label} description="Coming soon — this section isn't available yet." />
    </section>
  )
}

// ── Context section (auto-compaction levers) ─────────────────────────────────

/** "300k" / "1M" — the budget slider's tick labels. */
const fmtK = (n: number): string =>
  n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}k`

/**
 * Settings → Context.
 *
 * Every token lever in one place, because the numbers only make sense together:
 * a budget is meaningless without knowing what the sessions are actually using,
 * and the digest model is meaningless without knowing it runs on the user's own
 * subscription. Showing them apart would make each look arbitrary.
 */
function ContextSection({
  context,
  sessions,
  onSaveContext
}: {
  context?: ContextConfig | null
  sessions?: ReadonlyArray<{
    id: string
    title: string
    snapshot: ContextSnapshot
  }>
  onSaveContext?: (config: ContextConfig) => void
}) {
  const [draft, setDraft] = React.useState<ContextConfig>(
    context ?? DEFAULT_CONTEXT_CONFIG
  )
  React.useEffect(() => setDraft(context ?? DEFAULT_CONTEXT_CONFIG), [context])

  const save = (next: ContextConfig) => {
    setDraft(next)
    onSaveContext?.(next)
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-editor p-6">
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-6">
        <div className="flex items-center gap-2 border-b border-hairline pb-2.5">
          <Gauge size={14} className="text-text-bright" />
          <span className="text-[13px] font-semibold text-text-bright">
            Context
          </span>
        </div>

        <Callout tone="blue">
          Long conversations lose accuracy well before they hit a model&apos;s
          limit. Jingler summarises a session in the background once it outgrows
          the budget below, then quietly continues from that summary — your
          transcript is never truncated.
        </Callout>

        <SettingsCard title="Auto-compaction">
          <GeneralToggleRow
            label="Compact sessions automatically"
            description="Summarise and reseed in the background when a session outgrows its budget. Off leaves the selected provider model to enforce its own limit."
            checked={draft.auto}
            onChange={(auto) => save({ ...draft, auto })}
          />
          <SettingsRow
            className={draft.auto ? undefined : "pointer-events-none opacity-50"}
            label="Working-set budget"
            help="How much conversation a session carries before it is compacted. Lower keeps answers sharper; higher keeps more raw history in play."
            control={
              <div className="flex w-[240px] flex-col gap-1">
                <span className="self-end font-mono text-[12px] tabular-nums text-text-bright">
                  {fmtK(draft.budgetTokens)} tokens
                </span>
                <input
                  type="range"
                  min={BUDGET_RANGE.min}
                  max={BUDGET_RANGE.max}
                  step={8_000}
                  value={draft.budgetTokens}
                  disabled={!draft.auto}
                  onChange={(e) =>
                    save({ ...draft, budgetTokens: Number(e.target.value) })
                  }
                  aria-label="Working-set budget"
                  className="w-full accent-blue"
                />
                <div className="flex justify-between font-mono text-[10px] text-dim">
                  <span>{fmtK(BUDGET_RANGE.min)}</span>
                  <span>sharper ← → more history</span>
                  <span>{fmtK(BUDGET_RANGE.max)}</span>
                </div>
              </div>
            }
          />
        </SettingsCard>

        {sessions !== undefined && sessions.length > 0 && (
          <SettingsCard title="Your sessions right now">
            {sessions.map((s) => (
              <SettingsRow
                key={s.id}
                label={<span className="block truncate text-[12px] font-normal">{s.title}</span>}
                control={
                  s.snapshot.triggerAt === null ? (
                    <span className="font-mono text-[10.5px] text-dim">
                      not measurable
                    </span>
                  ) : (
                    <ContextMeter
                      tokens={s.snapshot.tokens}
                      triggerAt={s.snapshot.triggerAt}
                      phase={s.snapshot.phase}
                      preparing={s.snapshot.preparing}
                      digestReady={s.snapshot.digestReady}
                      stalled={s.snapshot.stalled}
                    />
                  )
                }
              />
            ))}
          </SettingsCard>
        )}
      </div>
    </div>
  )
}

// ── Plan section ─────────────────────────────────────────────────────────────

/** Settings → Plan: plan-mode auto-run and the starting plan template. */
function PlanSection({
  planAutoRun,
  onSavePlanAutoRun,
  planTemplate,
  onSavePlanTemplate
}: {
  planAutoRun?: boolean | null
  onSavePlanAutoRun?: (planAutoRun: boolean) => void | Promise<void>
  planTemplate?: PlanTemplateConfig | null
  onSavePlanTemplate?: (template: PlanTemplateConfig) => void | Promise<void>
}) {
  // Absent means ON, matching the renderer's default.
  const [autoRun, setAutoRun] = React.useState<boolean>(planAutoRun ?? true)
  React.useEffect(() => setAutoRun(planAutoRun ?? true), [planAutoRun])
  const [source, setSource] = React.useState<string>(planTemplate?.source ?? "")
  React.useEffect(() => setSource(planTemplate?.source ?? ""), [planTemplate])

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-editor p-6">
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-6">
        <div className="flex items-center gap-2 border-b border-hairline pb-2.5">
          <Sparkles size={14} className="text-text-bright" />
          <span className="text-[13px] font-semibold text-text-bright">
            Plan mode
          </span>
        </div>

        <Callout tone="blue">
          Plans are Markdown files reviewed and revised in Plannotator.
          Jingler&apos;s todo list, Plan drawer, progress dock, composer summary,
          and transcript card are read-only views of that plan.
        </Callout>

        <SettingsCard title="Execution">
          <GeneralToggleRow
            label="Plan auto-run"
            description="Let plan mode run its read-only commands without asking for approval each time."
            checked={autoRun}
            onChange={(next) => {
              setAutoRun(next)
              void onSavePlanAutoRun?.(next)
            }}
          />
        </SettingsCard>

        <SettingsCard title="Plan template">
          <SettingsRow
            label="Starting plan structure"
            help="A structured plan (JSON) injected into every planning turn. Leave empty to use the built-in blank draft."
            control={
              <AsyncButton
                variant="secondary"
                pendingLabel="Saving…"
                successLabel="Saved"
                onClick={() => onSavePlanTemplate?.({ source })}
              >
                Save template
              </AsyncButton>
            }
          />
          <div className="px-4 py-3">
            <Textarea
              value={source}
              onChange={(e) => setSource(e.target.value)}
              rows={8}
              spellCheck={false}
              aria-label="Plan template"
              className="font-mono text-[12px]"
            />
          </div>
        </SettingsCard>
      </div>
    </div>
  )
}

// ── GitHub section (migrated from the old settings modal) ────────────────────

const DEFAULT_GITHUB: GithubConfig = {
  enabled: false,
  autoCreatePr: false,
  autoDetectPr: true,
  postAdversarialReviewComments: true
}
const DEFAULT_GIT: GitConfig = { shareCheckedOutBranches: true }

/**
 * The four conversation text-size steps. Stored as the raw multiplier the
 * `--sb-font-scale` CSS var consumes, so the renderer needs no label→value map.
 */
/**
 * Preset multipliers for conversation + code text. The value is the raw number
 * the `--sb-font-scale` var consumes; `SegmentedControl` keys on strings, so the
 * row converts at the boundary. Four presets rather than a free slider: these
 * read cleanly against Jingler's hardcoded px sizes, and a preset can't land on
 * an awkward half-pixel.
 */
const FONT_SCALE_PRESETS = [
  { value: 0.9, label: "Small" },
  { value: 1, label: "Default" },
  { value: 1.15, label: "Large" },
  { value: 1.3, label: "Extra Large" }
] as const

/**
 * Text-size row: reuses the shared `SegmentedControl` (its `role="tablist"` +
 * `aria-selected` come for free) rather than a hand-rolled button group. Saves
 * on click, like the toggles above — there is nothing to review.
 */
function FontSizeRow({
  value,
  onChange
}: {
  value: number
  onChange: (v: number) => void
}) {
  return (
    <SettingsRow
      label="Text size"
      help="Scale the conversation and code text. The rest of the app stays put."
      control={
        <SegmentedControl
          value={String(value)}
          items={FONT_SCALE_PRESETS.map((preset) => ({
            value: String(preset.value),
            label: preset.label
          }))}
          onChange={(next) => onChange(Number(next))}
        />
      }
    />
  )
}

/** A General-section toggle on the cataloged SettingsRow. */
function GeneralToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange
}: {
  label: string
  description: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <SettingsRow
      label={label}
      help={description}
      control={<Toggle aria-label={label} checked={checked} disabled={disabled} onCheckedChange={onChange} />}
    />
  )
}

const OFFLOAD_STATUS_HELP = {
  priming: "Saving Offload Compute settings…",
  failed: "Offload Compute settings could not be saved.",
  readyCloud: "Cloud compute is enabled; eligible sessions prime in the background.",
  readyDevice: "Owned-device compute is enabled and will fail closed if that device is unavailable."
} as const

/** Offload row status: Priming… / Ready / Failed · Retry. Retry re-saves, which re-runs priming. */
function OffloadStatusRow({
  status,
  targetKind,
  onRetry
}: {
  status?: "disabled" | "priming" | "ready" | "failed"
  targetKind: "cloud" | "owned-device"
  onRetry?: () => void
}) {
  if (status !== "priming" && status !== "ready" && status !== "failed") return null
  const help =
    status === "ready"
      ? targetKind === "cloud" ? OFFLOAD_STATUS_HELP.readyCloud : OFFLOAD_STATUS_HELP.readyDevice
      : OFFLOAD_STATUS_HELP[status]
  return (
    <SettingsRow
      label="Status"
      help={<span role={status === "failed" ? "alert" : undefined}>{help}</span>}
      control={
        status === "failed" ? (
          <span className="flex items-center gap-1 text-[12px] text-state-failed">
            Failed <span aria-hidden>·</span>
            <Button variant="ghost" size="sm" onClick={onRetry}>
              Retry
            </Button>
          </span>
        ) : status === "priming" ? (
          <span role="status" className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Spinner size={12} /> Priming…
          </span>
        ) : (
          <span role="status" className="text-[12px] text-state-ready">
            Ready
          </span>
        )
      }
    />
  )
}

/**
 * Settings → General. Today that means desktop notifications.
 *
 * Per-kind toggles rather than one switch, because the kinds are not equally
 * interruptive: an operator who mutes "finished" (frequent, rarely urgent) must
 * not thereby lose "needs input", which is the one whose absence actually costs
 * them a stalled agent. Sound is separate again — it interrupts a room.
 *
 * Saves on every toggle. There is no Save button because there is nothing to
 * review: each switch is independently meaningful and instantly reversible.
 */
function GeneralSection({
  obsidianExplanations,
  onSaveObsidianExplanations,
  obsidianVaultConfigured,
  offloadCompute,
  onSaveOffloadCompute,
  offloadStatus,
  onRetryOffload,
  offloadEnvironments,
  onRefreshOffloadEnvironments,
  defaultMode,
  onSaveDefaultMode,
  adhdMode,
  onSaveAdhdMode,
  fontScale,
  onSaveFontScale,
  webSearch
}: {
  obsidianExplanations?: ObsidianExplanationsConfig | null
  onSaveObsidianExplanations?: (config: ObsidianExplanationsConfig) => void | Promise<void>
  obsidianVaultConfigured?: boolean
  offloadCompute?: OffloadComputeSettings | null
  onSaveOffloadCompute?: (settings: OffloadComputeSettings) => void | Promise<void>
  offloadStatus?: "disabled" | "priming" | "ready" | "failed"
  /** Re-run Offload Compute priming after a failed save. */
  onRetryOffload?: () => void
  offloadEnvironments: ReadonlyArray<Environment>
  onRefreshOffloadEnvironments?: () => void | Promise<void>
  defaultMode?: ExecutionMode | null
  onSaveDefaultMode?: (defaultMode: ExecutionMode) => void | Promise<void>
  adhdMode?: boolean | null
  onSaveAdhdMode?: (adhdMode: boolean) => void | Promise<void>
  fontScale?: number | null
  onSaveFontScale?: (fontScale: number) => void | Promise<void>
  webSearch?: WebSearchSettingsProps
}) {
  const [offloadDraft, setOffloadDraft] = React.useState<boolean>(
    offloadCompute?.enabled ?? false
  )
  React.useEffect(
    () => setOffloadDraft(offloadCompute?.enabled ?? false),
    [offloadCompute?.enabled]
  )
  const offloadTarget = offloadCompute?.target ?? { kind: "cloud" as const }
  const saveOffload = (settings: Partial<OffloadComputeSettings>): void => {
    void onSaveOffloadCompute?.({
      enabled: offloadDraft,
      target: offloadTarget,
      explicitCommands: offloadCompute?.explicitCommands ?? [],
      ...settings
    })
  }
  const [defaultModeDraft, setDefaultModeDraft] = React.useState<ExecutionMode>(
    defaultMode ?? "auto"
  )
  React.useEffect(
    () => setDefaultModeDraft(defaultMode ?? "auto"),
    [defaultMode]
  )
  // Absent means OFF, matching `ADHD_MODE_DEFAULT` in the domain.
  const [adhdDraft, setAdhdDraft] = React.useState<boolean>(adhdMode ?? false)
  React.useEffect(() => setAdhdDraft(adhdMode ?? false), [adhdMode])
  // Absent or malformed collapses to 1×, matching `FONT_SCALE_DEFAULT`.
  const [fontScaleDraft, setFontScaleDraft] = React.useState<number>(
    clampFontScale(fontScale)
  )
  React.useEffect(
    () => setFontScaleDraft(clampFontScale(fontScale)),
    [fontScale]
  )
  const [obsidianDraft, setObsidianDraft] = React.useState<ObsidianExplanationsConfig>(
    obsidianExplanations ?? OBSIDIAN_EXPLANATIONS_DEFAULT
  )
  React.useEffect(
    () => setObsidianDraft(obsidianExplanations ?? OBSIDIAN_EXPLANATIONS_DEFAULT),
    [obsidianExplanations]
  )
  const saveObsidian = (next: ObsidianExplanationsConfig) => {
    setObsidianDraft(next)
    void onSaveObsidianExplanations?.(next)
  }
  const toggle = (label: string, description: string, checked: boolean, onChange: (v: boolean) => void, disabled?: boolean) => (
    <GeneralToggleRow label={label} description={description} checked={checked} disabled={disabled} onChange={onChange} />
  )
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-editor p-6">
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-6">
        <SettingsCard title="Compute">
          {toggle(
            "Offload Compute",
            "When this machine is under sustained CPU or memory pressure, automatically run eligible lint, typecheck, test, build, and allowlisted argv on your preferred Cloud Sandbox or owned device. Interactive, stateful, shell-composed, and unknown commands stay local.",
            offloadDraft,
            (enabled) => {
              setOffloadDraft(enabled)
              saveOffload({ enabled })
            }
          )}
          <SettingsRow
            label="Compute target"
            help="The selected target is fail-closed; unavailable devices never fall back to cloud or local execution."
            control={
              <div className="flex w-[200px] flex-col items-stretch gap-2">
                <Select
                  value={offloadTarget.kind}
                  onValueChange={(value) => {
                    if (value === "cloud") saveOffload({ target: { kind: "cloud" } })
                    else if (offloadEnvironments[0]) {
                      saveOffload({
                        target: { kind: "owned-device", deviceId: offloadEnvironments[0].id }
                      })
                    }
                  }}
                >
                  <SelectTrigger ariaLabel="Offload Compute target" className="h-8 bg-sunken px-2 py-1.5 text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cloud">Cloud Sandbox</SelectItem>
                    <SelectItem value="owned-device" disabled={offloadEnvironments.length === 0}>
                      Owned device
                    </SelectItem>
                  </SelectContent>
                </Select>
                {offloadTarget.kind === "owned-device" && (
                  <Select
                    value={offloadTarget.deviceId}
                    onValueChange={(deviceId) => saveOffload({
                      target: { kind: "owned-device", deviceId }
                    })}
                  >
                    <SelectTrigger ariaLabel="Owned device for Offload Compute" className="h-8 bg-sunken px-2 py-1.5 text-[12px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {offloadEnvironments.map((environment) => (
                        <SelectItem key={environment.id} value={environment.id}>
                          {environment.name}{environment.state === "online" ? " · online" : " · offline"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <Button variant="ghost" size="sm" onClick={() => void onRefreshOffloadEnvironments?.()}>
                  Refresh devices
                </Button>
              </div>
            }
          />
          <OffloadStatusRow status={offloadStatus} targetKind={offloadTarget.kind} onRetry={onRetryOffload} />
        </SettingsCard>

        <SettingsCard title="Agent defaults">
          <SettingsRow
            label="Default mode"
            help="Start new chats in this permission mode for every model."
            control={
              <SegmentedControl
                value={defaultModeDraft}
                items={[
                  { value: "ask", label: "Ask" },
                  { value: "accept-edits", label: "Accept Edits" },
                  { value: "auto", label: "Auto" }
                ]}
                onChange={(next) => {
                  const mode = next as ExecutionMode
                  setDefaultModeDraft(mode)
                  void onSaveDefaultMode?.(mode)
                }}
              />
            }
          />
        </SettingsCard>

        <SettingsCard title="Responses">
          {toggle(
            "ADHD mode",
            "Only final completion summaries lead with the action, number multi-step work, state progress, and end with one next step. Working updates, planning, and questions stay natural.",
            adhdDraft,
            (next) => {
              setAdhdDraft(next)
              void onSaveAdhdMode?.(next)
            }
          )}
          <FontSizeRow
            value={fontScaleDraft}
            onChange={(next) => {
              setFontScaleDraft(next)
              void onSaveFontScale?.(next)
            }}
          />
        </SettingsCard>

        {webSearch ? <WebSearchSettings {...webSearch} /> : null}

        {obsidianVaultConfigured ? (
          <SettingsCard title="Obsidian">
            <GeneralToggleRow
              label="Save explanations to Obsidian"
              description="Write every explanation an agent publishes as a Markdown note in the session's vault. Publishing again updates the same note."
              checked={obsidianDraft.enabled}
              onChange={(enabled) => saveObsidian({ ...obsidianDraft, enabled })}
            />
            <div className="px-4 py-3">
              <Field label="Vault folder">
                {(c) => (
                  <Input
                    {...c}
                    value={obsidianDraft.folder}
                    disabled={!obsidianDraft.enabled}
                    onChange={(event) => setObsidianDraft({ ...obsidianDraft, folder: event.target.value })}
                    onBlur={() => saveObsidian(obsidianDraft)}
                  />
                )}
              </Field>
            </div>
          </SettingsCard>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Settings → Notifications. Per-kind toggles (see the module doc on the old
 * General section, moved here unchanged) plus the one thing a toggle can't
 * fix: macOS blocking Jingler at the OS level, which needs a way out, not a
 * switch.
 *
 * The warning row only ever renders for `permission === "denied"`. Main never
 * emits `denied` today (no platform probe exists — see `notificationPermission`
 * in apps/desktop/src/main/notifications.ts), so this row is dark in practice
 * until that detection lands. It must NOT fire for `unknown`: every macOS user
 * who hasn't explicitly blocked notifications reports `unknown` (Electron has
 * no permission query), so treating `unknown` as blocked would warn everyone.
 */
function NotificationsSection({
  notifications,
  onSaveNotifications,
  permission,
  onOpenSystemSettings
}: {
  notifications?: NotificationsConfig | null
  onSaveNotifications?: (config: NotificationsConfig) => void | Promise<void>
  permission?: NotificationPermission | null
  onOpenSystemSettings?: () => void | Promise<void>
}) {
  // Absent config means the DEFAULTS, not silence — an operator who never opened
  // this pane should still be told when an agent needs them.
  const [draft, setDraft] = React.useState<NotificationsConfig>(
    notifications ?? NOTIFICATIONS_DEFAULT
  )
  React.useEffect(() => {
    if (notifications) setDraft(notifications)
  }, [notifications])

  const set = (patch: Partial<NotificationsConfig>) => {
    const next = { ...draft, ...patch }
    setDraft(next)
    void onSaveNotifications?.(next)
  }

  const toggle = (label: string, description: string, checked: boolean, onChange: (v: boolean) => void, disabled?: boolean) => (
    <GeneralToggleRow label={label} description={description} checked={checked} disabled={disabled} onChange={onChange} />
  )

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-editor p-6">
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-6">
        {permission === "denied" && (
          <BannerShell
            placement="card"
            icon={<Bell size={14} />}
            actions={[
              <Button
                key="open-system-settings"
                variant="secondary"
                size="sm"
                onClick={() => void onOpenSystemSettings?.()}
              >
                Open System Settings
              </Button>
            ]}
          >
            Notifications are blocked by macOS
          </BannerShell>
        )}
        <SettingsCard title="Notifications">
          {toggle("Desktop notifications", "Tell me when a session needs me or stops, while Jingler is in the background.", draft.enabled, (enabled) => set({ enabled }))}
          {toggle("Needs input", "An agent is blocked waiting on your approval or an answer.", draft.needsInput, (needsInput) => set({ needsInput }), !draft.enabled)}
          {toggle("Run finished", "An agent completed its turn.", draft.done, (done) => set({ done }), !draft.enabled)}
          {toggle("Run failed", "An agent's run ended in an error.", draft.failed, (failed) => set({ failed }), !draft.enabled)}
          {toggle("Pull request resolved", "A session's pull request was merged or closed on GitHub.", draft.pr, (pr) => set({ pr }), !draft.enabled)}
          {toggle("Play a sound", "Use the system notification sound instead of showing them silently.", draft.sound, (sound) => set({ sound }), !draft.enabled)}
        </SettingsCard>
        <p className="text-[11px] leading-[1.6] text-muted-foreground">
          Notifications are suppressed for the session you already have open and
          focused — you can see that one for yourself.
        </p>
      </div>
    </div>
  )
}

function GithubSection({
  connection,
  busy,
  github,
  git,
  onConnect,
  onManage,
  onRefresh,
  onDisconnect,
  agentEndpointCatalog,
  onSaveGithub,
  onSaveGit
}: {
  connection: GitHubConnection
  busy?: boolean
  github?: GithubConfig | null
  git?: GitConfig | null
  onConnect?: () => void
  onManage?: () => void
  onRefresh?: () => void
  onDisconnect?: () => void
  agentEndpointCatalog?: AgentEndpointCatalog | null
  onSaveGithub?: (config: GithubConfig) => void
  onSaveGit?: (config: GitConfig) => void
}) {
  function renderConnectionStatus() {
    const title =
      connection.mode === "connecting"
        ? "Waiting for GitHub authorization"
        : connected
          ? `Connected as @${connection.user?.login ?? "user"}`
          : connection.mode === "error"
            ? "GitHub connection needs attention"
            : "GitHub is not connected"
    return (
      <SettingsCard title="Connection">
        <SettingsRow
          label={
            <span className="flex items-center gap-2">
              <StatusDot tone={getTone()} size={8} glow={connection.mode === "connected"} />
              <span>{title}</span>
            </span>
          }
          help={connection.user?.name}
          control={
            <div className="flex flex-wrap justify-end gap-2">
              {!connected ? (
                <Button variant="primary" size="sm" onClick={onConnect} disabled={busy}>
                  Install / Connect GitHub
                </Button>
              ) : (
                <>
                  <Button variant="primary" size="sm" onClick={onManage} disabled={busy}>
                    Manage repositories
                  </Button>
                  <Button variant="secondary" size="sm" onClick={onRefresh} disabled={busy}>
                    Refresh
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmDisconnect(true)} disabled={busy}>
                    Disconnect
                  </Button>
                </>
              )}
              {connection.mode === "connecting" && (
                <Button variant="secondary" size="sm" onClick={onRefresh}>
                  Cancel / check status
                </Button>
              )}
            </div>
          }
        />
      </SettingsCard>
    )
  }

  function getTone() {
    switch (connection.mode) {
case "connected": {
return ("bg-line-strong")
}
case "error": {
return ("bg-red")
}
case "disconnected": {
return ("bg-line-strong")
}
}
    return ("bg-line-strong")
  }

  const [draft, setDraft] = React.useState<GithubConfig>(
    github ?? DEFAULT_GITHUB
  )
  const [gitDraft, setGitDraft] = React.useState<GitConfig>(git ?? DEFAULT_GIT)
  const [confirmDisconnect, setConfirmDisconnect] = React.useState(false)

  React.useEffect(() => setDraft(github ?? DEFAULT_GITHUB), [github])
  React.useEffect(() => setGitDraft(git ?? DEFAULT_GIT), [git])

  const connected = connection.connected && connection.user !== null
  // Persist each toggle immediately so this section needs no separate Save.
  const setGithub = (next: GithubConfig) => {
    setDraft(next)
    onSaveGithub?.(next)
  }
  const setGitCfg = (next: GitConfig) => {
    setGitDraft(next)
    onSaveGit?.(next)
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-editor">
      <div className="flex max-w-[560px] flex-col gap-4 p-6">
        <div className="flex items-center gap-2 border-b border-hairline pb-2.5">
          <GithubMark size={14} className="text-text-bright" />
          <span className="text-[13px] font-semibold text-text-bright">
            GitHub
          </span>
        </div>

        {renderConnectionStatus()}

        {connection.cliAvailable && !connected && (
          <Callout tone="blue">
            GitHub CLI authenticated. Pull-request features work locally; install the GitHub App only for realtime feedback.
          </Callout>
        )}
        {connection.error && <Callout tone="red">{connection.error}</Callout>}
        {connection.mode === "partial-access" && (
          <Callout tone="blue">
            GitHub is connected, but at least one installation is suspended or
            limited to selected repositories. Manage repository access before
            using PR features there.
          </Callout>
        )}
        {connection.mode === "suspended" && (
          <Callout tone="red">
            Every visible GitHub App installation is suspended. Repair the
            installation on GitHub, then Refresh.
          </Callout>
        )}

        {connection.installations.length > 0 && (
          <SettingsCard title="GitHub installations">
            {connection.installations.map((installation) => (
              <SettingsRow
                key={installation.id}
                label={
                  <span className="flex items-center gap-2">
                    <StatusDot
                      tone={installation.status === "active" ? "bg-line-strong" : "bg-red"}
                      size={7}
                      glow={false}
                    />
                    <span>@{installation.account.login}</span>
                  </span>
                }
                help={
                  installation.status === "suspended"
                    ? "Suspended"
                    : installation.repositorySelection === "all"
                      ? "All repositories"
                      : "Selected repositories only"
                }
                control={<span className="font-mono text-[10px] text-dim">{installation.account.type}</span>}
              />
            ))}
          </SettingsCard>
        )}

        <SettingsCard title="Pull requests">
          <GeneralToggleRow
            label="Enable pull-request features"
            description="Show the Pull Request & Code Review tabs and allow posting reviews to GitHub."
            checked={draft.enabled}
            onChange={(enabled) => setGithub({ ...draft, enabled })}
          />
          <GeneralToggleRow
            label="Auto-detect pull requests"
            description="Link a PR automatically when one is already open on a session's branch."
            checked={draft.autoDetectPr}
            disabled={!draft.enabled}
            onChange={(autoDetectPr) => setGithub({ ...draft, autoDetectPr })}
          />
          <GeneralToggleRow
            label="Auto-create pull requests"
            description="Open a PR automatically once a session's branch has pushable commits."
            checked={draft.autoCreatePr}
            disabled={!draft.enabled}
            onChange={(autoCreatePr) => setGithub({ ...draft, autoCreatePr })}
          />
        </SettingsCard>

        <SettingsCard title="Adversarial review">
          {agentEndpointCatalog && (
            <SettingsRow
              label="Review model"
              help="Desktop harness and model used for read-only adversarial reviews."
              control={
                <ProviderModelBrowser
                  catalog={{
                    ...agentEndpointCatalog,
                    endpoints: agentEndpointCatalog.endpoints.filter(
                      ({ endpoint }) => endpoint.targetId === "desktop"
                    )
                  }}
                  endpointId={draft.adversarialReviewModel?.endpointId}
                  connectionId={null}
                  providerId={draft.adversarialReviewModel?.providerId}
                  modelId={draft.adversarialReviewModel?.modelId ?? null}
                  onSelect={({ runtimeId, endpointId, providerId, modelId }) =>
                    setGithub({
                      ...draft,
                      adversarialReviewModel: { runtimeId, endpointId, providerId, modelId }
                    })
                  }
                  className="max-w-[220px]"
                />
              }
            />
          )}
          <GeneralToggleRow
            label="Auto-run on new commits"
            description="Review a pull request automatically when it opens and each time its head advances. Runs at most once per commit."
            checked={draft.autoAdversarialReview ?? false}
            disabled={!draft.enabled}
            onChange={(autoAdversarialReview) => setGithub({ ...draft, autoAdversarialReview })}
          />
          <GeneralToggleRow
            label="Post low-severity findings to the pull request"
            description="Turn off to keep adversarial feedback local and send every finding to the session agent instead."
            checked={draft.postAdversarialReviewComments ?? true}
            disabled={!draft.enabled}
            onChange={(postAdversarialReviewComments) => setGithub({ ...draft, postAdversarialReviewComments })}
          />
        </SettingsCard>
        <p className="text-[11px] leading-[1.6] text-muted-foreground">
          Reviews run read-only on the selected desktop harness. Until you choose
          one, Jingler uses each session&apos;s pinned model.
        </p>

        <SettingsCard title="Git">
          <GeneralToggleRow
            label="Open PRs whose branch is checked out elsewhere"
            description="Start a session from a PR even when its branch is already checked out in another worktree. The worktrees then share the branch."
            checked={gitDraft.shareCheckedOutBranches}
            onChange={(shareCheckedOutBranches) => setGitCfg({ shareCheckedOutBranches })}
          />
        </SettingsCard>
      </div>
      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect GitHub?"
        description="Pull-request features stop working until you reconnect. Your GitHub App installation stays in place on GitHub."
        confirmLabel="Disconnect"
        destructive
        onConfirm={() => onDisconnect?.()}
      />
    </div>
  )
}
