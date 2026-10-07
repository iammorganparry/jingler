import * as React from "react"
import type {
  AgentEndpointCatalog,
  GitHubConnection,
  GitConfig,
  GithubConfig,
  NotificationsConfig,
  OffloadComputeSettings,
  ContextConfig,
  ContextSnapshot,
  Environment,
  ExecutionMode
} from "@jingler/core"
import {
  BUDGET_RANGE,
  DEFAULT_CONTEXT_CONFIG,
  NOTIFICATIONS_DEFAULT,
  clampFontScale
} from "@jingler/core"
import { ContextMeter } from "./context-meter.js"
import {
  ProviderConnectionsSettings,
  type ProviderConnectionsSettingsProps
} from "./provider-connections-settings.js"
import {
  Boxes,
  ChevronRight,
  Cloud,
  Cpu,
  Keyboard,
  FolderCog,
  Palette,
  Plug,
  RefreshCw,
  Server,
  ShieldCheck,
  Gauge,
  SlidersHorizontal,
  Sparkles,
  X
} from "lucide-react"
import { cn } from "../lib/cn.js"
import { atLeast, useWidthTier } from "../hooks/width-tier.js"
import { Button } from "../components/button.js"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/beui/select.js"
import { Callout } from "../components/callout.js"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../components/dialog.js"
import { Eyebrow } from "../components/eyebrow.js"
import { GithubMark } from "../components/github-mark.js"
import { ThemesSettings, type ThemesSettingsProps } from "./themes-settings.js"
import {
  PluginsSettings,
  type PluginsSettingsProps
} from "./plugins-settings.js"
import { SegmentedControl } from "../components/segmented-control.js"
import { StatusDot } from "../components/status-dot.js"
import { Toggle } from "../components/toggle.js"
import { McpSettings, type McpSettingsProps } from "./mcp-settings.js"
import { Input } from "../components/input.js"
import {
  EnvironmentDialog,
  type EnvironmentDialogProps
} from "./environment-dialog.js"
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

const NAV: ReadonlyArray<NavItem> = [
  {
    key: "general",
    label: "General",
    icon: <SlidersHorizontal size={14} />,
    ready: true
  },
  { key: "projects", label: "Projects", icon: <FolderCog size={14} />, ready: true },
  { key: "devices", label: "Devices", icon: <Server size={14} />, ready: true },
  {
    key: "providers",
    label: "Providers",
    icon: <Cpu size={14} />,
    ready: true
  },
  { key: "context", label: "Context", icon: <Gauge size={14} />, ready: true },
  { key: "plan", label: "Plan", icon: <Sparkles size={14} />, ready: true },
  {
    key: "agents",
    label: "Agents & skills",
    icon: <Sparkles size={14} />,
    ready: true
  },
  {
    key: "runtime",
    label: "Runtime",
    icon: <Gauge size={14} />,
    ready: true
  },
  {
    key: "permissions",
    label: "Permissions",
    icon: <ShieldCheck size={14} />,
    ready: false
  },
  {
    key: "connectors",
    label: "MCP servers",
    icon: <Plug size={14} />,
    ready: true
  },
  {
    key: "github",
    label: "GitHub",
    icon: <GithubMark size={14} />,
    ready: true
  },
  { key: "themes", label: "Themes", icon: <Palette size={14} />, ready: true },
  { key: "plugins", label: "Plugins", icon: <Boxes size={14} />, ready: true },
  {
    key: "keybindings",
    label: "Keybindings",
    icon: <Keyboard size={14} />,
    ready: false
  }
]

export interface SettingsViewProps {
  routines?: (projectId: string) => import("react").ReactNode
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
    dialog: EnvironmentDialogProps
    onOpen: () => void
    onRefresh: () => void | Promise<void>
    onRename: (id: string, name: string) => void | Promise<void>
    onRevoke: (id: string) => void | Promise<void>
  }
  /** MCP servers from ~/jingler/mcp.json (from `useMcpSettings`). */
  mcp?: McpSettingsProps
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
  /** Desktop-notification prefs; absent means the defaults, not "off". */
  notifications?: NotificationsConfig | null
  onSaveNotifications?: (config: NotificationsConfig) => void | Promise<void>
  /** Automatic read-only cloud routing for eligible agent commands. */
  offloadCompute?: OffloadComputeSettings | null
  onSaveOffloadCompute?: (settings: OffloadComputeSettings) => void | Promise<void>
  offloadStatus?: "disabled" | "priming" | "ready" | "failed"
  /** Permission mode used for new chats across every provider model. */
  defaultMode?: ExecutionMode | null
  onSaveDefaultMode?: (defaultMode: ExecutionMode) => void | Promise<void>
  /** Whether plan mode runs commands unattended; absent means on. */
  planAutoRun?: boolean | null
  onSavePlanAutoRun?: (planAutoRun: boolean) => void | Promise<void>
  /** Whether final completion summaries are shaped for an ADHD reader. */
  adhdMode?: boolean | null
  onSaveAdhdMode?: (adhdMode: boolean) => void | Promise<void>
  /** Multiplier for conversation + code text size; absent means 1×. */
  fontScale?: number | null
  onSaveFontScale?: (fontScale: number) => void | Promise<void>
  /** Close the view and return to the active session. */
  onClose?: () => void
  /** Recovery actions open directly on GitHub; ordinary Settings opens Providers. */
  initialSection?: "providers" | "github" | "devices" | "agents" | "runtime"
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
  plugins,
  devices,
  mcp,
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
  notifications,
  onSaveNotifications,
  offloadCompute,
  onSaveOffloadCompute,
  offloadStatus,
  defaultMode,
  onSaveDefaultMode,
  adhdMode,
  onSaveAdhdMode,
  fontScale,
  onSaveFontScale,
  onClose,
  initialSection = "providers"
}: SettingsViewProps) {
         function getSection() {
           switch (section) {
case "devices": {
return (renderOptionalSection(devices, (props) => <DevicesSection {...props} />, "Devices"))
}
case "routines":
case "projects": {
return renderOptionalSection(projectWorkflows, (props) => <ProjectWorkflowSettings {...props} routines={routines} />, "Projects")
}
case "general": {
return (<GeneralSection
          notifications={notifications}
          onSaveNotifications={onSaveNotifications}
          offloadCompute={offloadCompute}
          onSaveOffloadCompute={onSaveOffloadCompute}
          offloadStatus={offloadStatus}
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
case "providers": {
return (renderOptionalSection(providerConnections, (props) => <ProviderConnectionsSettings {...props} />, "Providers"))
}
case "context": {
return (<ContextSection
          context={context}
          sessions={contextSessions}
          onSaveContext={onSaveContext}
        />)
}
case "plan": {
return (<div className="flex min-w-0 flex-1 flex-col overflow-auto bg-editor p-6">
          <div className="mx-auto w-full max-w-[760px] rounded-xl border border-line bg-panel p-5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-purple">
              Plannotator
            </p>
            <h2 className="mt-1 text-[19px] font-semibold text-text-bright">Plan mode</h2>
            <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
              Plans are Markdown files reviewed and revised in Plannotator. Jingler&apos;s todo list,
              Plan drawer, progress dock, composer summary, and transcript card are read-only views
              of that plan.
            </p>
          </div>
        </div>)
}
case "agents": {
return (renderOptionalSection(agents, (props) => <AgentsSettings {...props} />, "Agents & skills"))
}
case "runtime": {
return (renderOptionalSection(runtimeInspector, (props) => <RuntimeInspector {...props} />, "Runtime"))
}
case "connectors": {
return (<div className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-editor p-6">
          {renderOptionalSection(mcp, (props) => <McpSettings {...props} />, "MCP servers")}
        </div>)
}
case "plugins": {
return (renderOptionalSection(plugins, (props) => <PluginsSettings {...props} />, "Plugins"))
}
case "themes": {
return (renderOptionalSection(themes, (props) => <ThemesSettings {...props} />, "Themes"))
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
  const selectSection = (next: SectionKey) => {
    setSection(next)
    if (next === "providers") providerConnections?.onReload?.()
    if (next === "runtime") runtimeInspector?.onRefresh()
  }

  // Three `flex-none` columns (216 + 328 + detail) is ~544px of chrome before
  // the settings themselves get a pixel. Below `mid` the nav narrows to an icon
  // rail so the section you're editing keeps the room.
  const compact = !atLeast(useWidthTier(), "mid")

  return (
    <div className="flex min-h-0 flex-1 bg-editor">
      {/* nav */}
      <nav
        className={cn(
          "flex flex-none flex-col gap-0.5 border-r border-hairline bg-panel p-2.5",
          compact ? "w-[56px] items-center" : "w-[216px]"
        )}
      >
        <div
          className={cn(
            "flex items-center px-2.5 pb-1.5 pt-1",
            compact ? "justify-center" : "justify-between"
          )}
        >
          {!compact && <Eyebrow>Settings</Eyebrow>}
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
        {NAV.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => selectSection(item.key)}
            aria-current={section === item.key}
            // The label is the accessible name in both modes — the compact rail
            // hides the TEXT, not the name, so a by-name lookup still finds it.
            aria-label={item.label}
            title={item.label}
            className={cn(
              "flex items-center gap-2.5 rounded-md py-2 text-[13px] transition-colors",
              compact ? "justify-center px-2" : "px-2.5",
              section === item.key
                ? "border border-blue/45 bg-surface font-semibold text-text-bright shadow-[0_0_0_3px] shadow-blue/10"
                : "border border-transparent text-text-body hover:bg-surface/60"
            )}
          >
            <span
              className={cn(
                section === item.key ? "text-blue" : "text-muted-foreground"
              )}
            >
              {item.icon}
            </span>
            {!compact && <span className="flex-1 text-left">{item.label}</span>}
            {!compact && item.key === "providers" && (
              <span className="rounded bg-hover px-1.5 py-px font-mono text-[9px] text-muted-foreground">
                {providerConnections?.catalog?.connections.length ?? 0}
              </span>
            )}
          </button>
        ))}
        {/* A three-line path caption is the first thing to go at 56px — it is
            reference material, not navigation, and the same path is printed in
            the Settings body. */}
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

export function DevicesSection({
  environments,
  loading,
  error,
  dialog,
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
            <h2 className="text-[16px] font-semibold text-text-bright">
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
            <div className="px-4 py-10 text-center text-[12px] text-muted-foreground">
              {loading ? "Loading devices…" : "No owned machines yet."}
            </div>
          ) : (
            environments.map((environment) => {
                               function getClassName() {
                                 switch (environment.state) {
case "online": {
return ("bg-green/10 text-green")
}
case "incompatible": {
return ("bg-yellow/10 text-yellow")
}
case "revoked": {
return ("bg-red/10 text-red")
}
}
                                 return ("bg-surface text-muted-foreground")
                               }
return ((
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
                </div>
                <span
                  className={cn(
                    "rounded-full px-2 py-1 text-[10px] font-medium",
                    getClassName()
                  )}
                >
                  {environment.state}
                </span>
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
                    onClick={() => {
                      if (
                        window.confirm(
                          `Revoke ${environment.name}? Active remote sessions will disconnect.`
                        )
                      )
                        void onRevoke(environment.id)
                    }}
                  >
                    Revoke
                  </Button>
                )}
              </div>
            )); })
          )}
        </div>
      </div>
      <EnvironmentDialog {...dialog} />
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
            <label
              htmlFor="environment-rename-name"
              className="flex flex-col gap-2 text-[11px] font-medium text-muted-foreground"
            >
              Name
              <Input
                id="environment-rename-name"
                aria-label="Environment name"
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submitRename()
                }}
                disabled={renamePending}
              />
            </label>
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
    <div className="flex flex-1 flex-col items-center justify-center gap-2 bg-editor text-center">
      <span className="text-[14px] font-semibold text-text-body">{label}</span>
      <span className="max-w-[280px] text-[12px] leading-relaxed text-muted-foreground">
        This section isn&apos;t wired up yet — it&apos;s coming in a later pass.
      </span>
    </div>
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
    <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-editor">
      <div className="flex max-w-[560px] flex-col gap-4 p-6">
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

        <div className="divide-y divide-hairline">
          <ToggleRow
            label="Compact sessions automatically"
            description="Summarise and reseed in the background when a session outgrows its budget. Off leaves the selected provider model to enforce its own limit."
            checked={draft.auto}
            onChange={(auto) => save({ ...draft, auto })}
          />
        </div>

        {/* ── The budget ── */}
        <div className={draft.auto ? "" : "pointer-events-none opacity-50"}>
          <div className="flex items-baseline justify-between">
            <span className="text-[12.5px] font-medium text-text-body">
              Working-set budget
            </span>
            <span className="font-mono text-[12px] tabular-nums text-text-bright">
              {fmtK(draft.budgetTokens)} tokens
            </span>
          </div>
          <p className="mt-0.5 text-[11px] leading-[1.5] text-muted-foreground">
            How much conversation a session carries before it is compacted.
            Lower keeps answers sharper; higher keeps more raw history in play.
          </p>
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
            className="mt-2.5 w-full accent-blue"
          />
          <div className="flex justify-between font-mono text-[10px] text-dim">
            <span>{fmtK(BUDGET_RANGE.min)}</span>
            <span>sharper ← → more history</span>
            <span>{fmtK(BUDGET_RANGE.max)}</span>
          </div>
        </div>

        {/* ── Live sessions ── */}
        {sessions !== undefined && sessions.length > 0 && (
          <div className="rounded-lg border border-line bg-sunken p-3">
            <Eyebrow>Your sessions right now</Eyebrow>
            <div className="mt-1.5 space-y-1.5">
              {sessions.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between gap-3"
                >
                  <span className="min-w-0 flex-1 truncate text-[12px] text-text-body">
                    {s.title}
                  </span>
                  {s.snapshot.triggerAt === null ? (
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
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
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

function ToggleRow({
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
    <div className="flex items-start gap-3 py-2.5">
      <div className="flex-1">
        <div className="text-[12.5px] font-medium text-text-body">{label}</div>
        <div className="mt-0.5 text-[11px] leading-[1.5] text-muted-foreground">
          {description}
        </div>
      </div>
      <Toggle
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        className="mt-0.5"
      />
    </div>
  )
}

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
    <div className="flex items-start gap-3 py-2.5">
      <div className="flex-1">
        <div className="text-[12.5px] font-medium text-text-body">
          Text size
        </div>
        <div className="mt-0.5 text-[11px] leading-[1.5] text-muted-foreground">
          Scale the conversation and code text. The rest of the app stays put.
        </div>
      </div>
      <SegmentedControl
        className="mt-0.5 flex-none"
        value={String(value)}
        items={FONT_SCALE_PRESETS.map((preset) => ({
          value: String(preset.value),
          label: preset.label
        }))}
        onChange={(next) => onChange(Number(next))}
      />
    </div>
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
  notifications,
  onSaveNotifications,
  offloadCompute,
  onSaveOffloadCompute,
  offloadStatus,
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
  notifications?: NotificationsConfig | null
  onSaveNotifications?: (config: NotificationsConfig) => void | Promise<void>
  offloadCompute?: OffloadComputeSettings | null
  onSaveOffloadCompute?: (settings: OffloadComputeSettings) => void | Promise<void>
  offloadStatus?: "disabled" | "priming" | "ready" | "failed"
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
  function getOffloadStatus() {
    switch (offloadStatus) {
case "priming": {
return (<p className="px-1 py-2 text-[11px] text-muted-foreground" role="status">
              Saving Offload Compute settings…
            </p>)
}
case "ready": {
return (<p className="px-1 py-2 text-[11px] text-success" role="status">
              {offloadTarget.kind === "cloud"
                ? "Cloud compute is enabled; eligible sessions prime in the background."
                : "Owned-device compute is enabled and will fail closed if that device is unavailable."}
            </p>)
}
case "failed": {
return (<p className="px-1 py-2 text-[11px] text-danger" role="alert">
              Offload Compute settings could not be saved.
            </p>)
}
}
    return (null)
  }

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

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-editor p-6">
      <div className="mx-auto w-full max-w-[560px]">
        <div className="mb-1 flex items-center gap-2 border-b border-hairline pb-2.5">
          <span className="text-[13px] font-semibold text-text-bright">
            Compute
          </span>
        </div>
        <div className="divide-y divide-hairline">
          <ToggleRow
            label="Offload Compute"
            description="When this machine is under sustained CPU or memory pressure, automatically run eligible lint, typecheck, test, build, and allowlisted argv on your preferred Cloud Sandbox or owned device. Interactive, stateful, shell-composed, and unknown commands stay local."
            checked={offloadDraft}
            onChange={(enabled) => {
              setOffloadDraft(enabled)
              saveOffload({ enabled })
            }}
          />
          <div className="space-y-2 px-1 py-3">
              <div className="flex items-center justify-between">
                <label className="block text-[11px] font-medium text-muted-foreground" htmlFor="offload-target">
                  Compute target
                </label>
                <button
                  type="button"
                  className="text-[10px] text-blue hover:underline"
                  onClick={() => void onRefreshOffloadEnvironments?.()}
                >
                  Refresh devices
                </button>
              </div>
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
              <p className="text-[10px] text-dim">
                The selected target is fail-closed; unavailable devices never fall back to cloud or local execution.
              </p>
          </div>
          {getOffloadStatus()}
        </div>

        <div className="mb-1 mt-6 flex items-center gap-2 border-b border-hairline pb-2.5">
          <span className="text-[13px] font-semibold text-text-bright">
            Agent defaults
          </span>
        </div>
        <div className="flex items-start gap-3 py-2.5">
          <div className="flex-1">
            <div className="text-[12.5px] font-medium text-text-body">
              Default mode
            </div>
            <div className="mt-0.5 text-[11px] leading-[1.5] text-muted-foreground">
              Start new chats in this permission mode for every model.
            </div>
          </div>
          <SegmentedControl
            className="mt-0.5 flex-none"
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
        </div>

        <div className="mb-1 mt-6 flex items-center gap-2 border-b border-hairline pb-2.5">
          <span className="text-[13px] font-semibold text-text-bright">
            Responses
          </span>
        </div>
        <div className="divide-y divide-hairline">
          <ToggleRow
            label="ADHD mode"
            description="Only final completion summaries lead with the action, number multi-step work, state progress, and end with one next step. Working updates, planning, and questions stay natural."
            checked={adhdDraft}
            onChange={(next) => {
              setAdhdDraft(next)
              void onSaveAdhdMode?.(next)
            }}
          />
          <FontSizeRow
            value={fontScaleDraft}
            onChange={(next) => {
              setFontScaleDraft(next)
              void onSaveFontScale?.(next)
            }}
          />
        </div>

        {webSearch ? <WebSearchSettings {...webSearch} /> : null}

        <div className="mb-1 mt-6 flex items-center gap-2 border-b border-hairline pb-2.5">
          <span className="text-[13px] font-semibold text-text-bright">
            Notifications
          </span>
        </div>
        <div className="divide-y divide-hairline">
          <ToggleRow
            label="Desktop notifications"
            description="Tell me when a session needs me or stops, while Jingler is in the background."
            checked={draft.enabled}
            onChange={(enabled) => set({ enabled })}
          />
          <ToggleRow
            label="Needs input"
            description="An agent is blocked waiting on your approval or an answer."
            checked={draft.needsInput}
            disabled={!draft.enabled}
            onChange={(needsInput) => set({ needsInput })}
          />
          <ToggleRow
            label="Run finished"
            description="An agent completed its turn."
            checked={draft.done}
            disabled={!draft.enabled}
            onChange={(done) => set({ done })}
          />
          <ToggleRow
            label="Run failed"
            description="An agent's run ended in an error."
            checked={draft.failed}
            disabled={!draft.enabled}
            onChange={(failed) => set({ failed })}
          />
          <ToggleRow
            label="Pull request resolved"
            description="A session's pull request was merged or closed on GitHub."
            checked={draft.pr}
            disabled={!draft.enabled}
            onChange={(pr) => set({ pr })}
          />
          <ToggleRow
            label="Play a sound"
            description="Use the system notification sound instead of showing them silently."
            checked={draft.sound}
            disabled={!draft.enabled}
            onChange={(sound) => set({ sound })}
          />
        </div>
        <p className="mt-4 text-[11px] leading-[1.6] text-muted-foreground">
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
    return (<div className="flex items-center gap-2.5 rounded-lg border border-line bg-sunken px-3 py-2.5">
          <StatusDot
            tone={
              getTone()
            }
            size={8}
            glow={connection.mode === "connected"}
          />
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium text-text-body">
              {connection.mode === "connecting"
                ? "Waiting for GitHub authorization"
                : connected
                  ? `Connected as @${connection.user?.login ?? "user"}`
                  : connection.mode === "error"
                    ? "GitHub connection needs attention"
                    : "GitHub is not connected"}
            </div>
            {connection.user?.name && (
              <div className="mt-0.5 truncate text-[10.5px] text-muted-foreground">
                {connection.user.name}
              </div>
            )}
          </div>
        </div>)
  }

  function getTone() {
    switch (connection.mode) {
case "connected": {
return ("bg-green")
}
case "error": {
return ("bg-red")
}
case "disconnected": {
return ("bg-line-strong")
}
}
    return ("bg-yellow")
  }

  const [draft, setDraft] = React.useState<GithubConfig>(
    github ?? DEFAULT_GITHUB
  )
  const [gitDraft, setGitDraft] = React.useState<GitConfig>(git ?? DEFAULT_GIT)

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
          <div
            className="flex flex-col gap-2"
            aria-label="GitHub installations"
          >
            {connection.installations.map((installation) => (
              <div
                key={installation.id}
                className="flex items-center gap-2.5 rounded-lg border border-line bg-hover px-3 py-2.5"
              >
                <StatusDot
                  tone={
                    installation.status === "active" ? "bg-green" : "bg-red"
                  }
                  size={7}
                  glow={false}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium text-text-body">
                    @{installation.account.login}
                  </div>
                  <div className="mt-0.5 text-[10.5px] text-muted-foreground">
                    {installation.status === "suspended"
                      ? "Suspended"
                      : installation.repositorySelection === "all"
                        ? "All repositories"
                        : "Selected repositories only"}
                  </div>
                </div>
                <span className="font-mono text-[10px] text-dim">
                  {installation.account.type}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {!connected ? (
            <Button
              variant="primary"
              size="sm"
              onClick={onConnect}
              disabled={busy}
            >
              Install / Connect GitHub
            </Button>
          ) : (
            <>
              <Button
                variant="primary"
                size="sm"
                onClick={onManage}
                disabled={busy}
              >
                Manage repositories
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={onRefresh}
                disabled={busy}
              >
                Refresh
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onDisconnect}
                disabled={busy}
              >
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

        <div className="divide-y divide-hairline">
          <ToggleRow
            label="Enable pull-request features"
            description="Show the Pull Request & Code Review tabs and allow posting reviews to GitHub."
            checked={draft.enabled}
            onChange={(enabled) => setGithub({ ...draft, enabled })}
          />
          <ToggleRow
            label="Auto-detect pull requests"
            description="Link a PR automatically when one is already open on a session's branch."
            checked={draft.autoDetectPr}
            disabled={!draft.enabled}
            onChange={(autoDetectPr) => setGithub({ ...draft, autoDetectPr })}
          />
          <ToggleRow
            label="Auto-create pull requests"
            description="Open a PR automatically once a session's branch has pushable commits."
            checked={draft.autoCreatePr}
            disabled={!draft.enabled}
            onChange={(autoCreatePr) => setGithub({ ...draft, autoCreatePr })}
          />
        </div>

        {/* Adversarial review */}
        <div className="mt-1 flex items-center gap-2 border-b border-hairline pb-2.5">
          <span className="text-[13px] font-semibold text-text-bright">
            Adversarial review
          </span>
        </div>
        {agentEndpointCatalog && (
          <div className="flex items-center gap-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-medium text-text-body">Review model</div>
              <div className="mt-0.5 text-[11px] leading-[1.5] text-muted-foreground">
                Desktop harness and model used for read-only adversarial reviews.
              </div>
            </div>
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
          </div>
        )}
        <div className="divide-y divide-hairline">
          <ToggleRow
            label="Auto-run on new commits"
            description="Review a pull request automatically when it opens and each time its head advances. Runs at most once per commit."
            checked={draft.autoAdversarialReview ?? false}
            disabled={!draft.enabled}
            onChange={(autoAdversarialReview) =>
              setGithub({ ...draft, autoAdversarialReview })
            }
          />
          <ToggleRow
            label="Post low-severity findings to the pull request"
            description="Turn off to keep adversarial feedback local and send every finding to the session agent instead."
            checked={draft.postAdversarialReviewComments ?? true}
            disabled={!draft.enabled}
            onChange={(postAdversarialReviewComments) =>
              setGithub({ ...draft, postAdversarialReviewComments })
            }
          />
        </div>
        <p className="text-[11px] leading-[1.6] text-muted-foreground">
          Reviews run read-only on the selected desktop harness. Until you choose
          one, Jingler uses each session&apos;s pinned model.
        </p>

        <div className="mt-1 flex items-center gap-2 border-b border-hairline pb-2.5">
          <span className="text-[13px] font-semibold text-text-bright">
            Git
          </span>
        </div>
        <div className="divide-y divide-hairline">
          <ToggleRow
            label="Open PRs whose branch is checked out elsewhere"
            description="Start a session from a PR even when its branch is already checked out in another worktree. The worktrees then share the branch."
            checked={gitDraft.shareCheckedOutBranches}
            onChange={(shareCheckedOutBranches) =>
              setGitCfg({ shareCheckedOutBranches })
            }
          />
        </div>
      </div>
    </div>
  )
}
