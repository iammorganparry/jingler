import type { Meta, StoryObj } from "@storybook/react-vite"
import type { GitHubConnection } from "@jingler/core"
import { SettingsView } from "./settings-view.js"
import { ToolCall } from "./tool-call.js"
import { ThoughtBlock } from "./thought-block.js"
import { PhaseNode } from "./phase-node.js"
import { AgentCard } from "./agent-card.js"
import { ApprovalGate } from "./approval-gate.js"
import { SlashCommandRow } from "./slash-command-row.js"
import { CommandMenu } from "./command-menu.js"
import { MentionMenu } from "./mention-menu.js"
import { Composer } from "./composer.js"
import { Callout } from "../components/callout.js"
import { TerminalDock, type DockSide, type TerminalTab } from "../app/terminal-panel.js"
import { useState } from "react"

const meta: Meta = { title: "Molecules/Overview" }
export default meta
type Story = StoryObj

export const ToolCalls: Story = {
  render: () => (
    <div className="flex w-80 flex-col gap-2">
      <ToolCall status="success" name="Read" target="billing.ts" meta="142" />
      <ToolCall status="running" name="Grep" target="TODO" />
      <ToolCall status="error" name="Bash" target="build" meta="exit 1" />
    </div>
  )
}

/** With an agent-written `intent`: the intent is the title, the raw command drops to a dim mono line. */
export const ToolCallsWithIntent: Story = {
  render: () => (
    <div className="flex w-80 flex-col gap-2">
      <ToolCall status="success" name="Bash" target="Running tests" detail="pnpm test" meta="exit 0" />
      <ToolCall status="running" name="Bash" target="Finding the retry logic" detail="grep -rn retry src" />
    </div>
  )
}

/** A failed MCP call classified as an auth failure offers sign-in. */
export const ToolCallNeedsSignIn: Story = {
  render: () => (
    <div className="flex w-96 flex-col gap-2">
      <ToolCall status="error" name="List pods" target="runpod" signIn={{ label: "Sign in to RunPod", onClick: () => {} }} />
    </div>
  )
}

export const Thought: Story = {
  render: () => (
    <div className="w-80">
      <ThoughtBlock seconds={6} defaultOpen>
        Reasoning summary, dim &amp; collapsible.
      </ThoughtBlock>
    </div>
  )
}

export const Phases: Story = {
  render: () => (
    <div className="flex w-80 flex-col gap-2">
      <PhaseNode index="02" title="Audit" state="active" hint="viewing" counts="5✓ 6● 1✗" />
      <PhaseNode index="03" title="Verify" state="pending" />
    </div>
  )
}

export const Agents: Story = {
  render: () => (
    <div className="flex w-80 flex-col gap-2">
      <AgentCard file="billing.ts" state="working" tokens="31k" status="reading middleware…" />
      <AgentCard file="api-keys.ts" state="flagged" status="⚠ 2 findings" />
      <AgentCard file="routes.ts" state="done" status="3 files changed" tokens="48k" />
      <AgentCard file="schema.ts" state="stopped" status="stopped by you" />
      <AgentCard file="auth.ts" state="failed" reason="Tool timed out after 120s" onResume={() => undefined} onViewTranscript={() => undefined} />
    </div>
  )
}

export const Callouts: Story = {
  render: () => (
    <div className="flex w-80 flex-col gap-2">
      <Callout tone="yellow">Large workflow — 26 agents.</Callout>
      <Callout tone="green">Verified by a reviewer.</Callout>
    </div>
  )
}

export const Approval: Story = {
  render: () => (
    <div className="w-[456px]">
      <ApprovalGate
        kind="command"
        title="Approval needed · run a command"
        detail="Not in your allowlist. Agents never run shell commands until you allow."
        command="npm test -- billing"
        allowLabel="npm test"
        status="pending"
      />
    </div>
  )
}

export const Rows: Story = {
  render: () => (
    <div className="flex w-80 flex-col gap-2">
      <SlashCommandRow name="review" description="Review the current diff" badge="built-in" active />
    </div>
  )
}

const MENU_SKILLS = [
  { name: "/review", description: "Review the current diff", source: "command" as const },
  { name: "/deploy", description: "Ship the current branch to production", source: "skill" as const }
]
const MENU_FILES = [
  "src/components/composer/autocomplete/a-very-long-directory-name/another-nested-directory/mention-menu.tsx",
  "src/index.ts",
  "README.md"
]

/** Compare with Paper board 22a (mention menu). */
export const AutocompleteMenus: Story = {
  render: () => (
    <div className="flex w-[456px] flex-col gap-4">
      <CommandMenu skills={MENU_SKILLS} activeIndex={0} query="e" onSelect={() => {}} />
      <MentionMenu files={MENU_FILES} activeIndex={0} query="m" onSelect={() => {}} />
      <MentionMenu files={[]} activeIndex={0} query="zzz" onSelect={() => {}} />
    </div>
  )
}

export const ComposerStory: Story = {
  name: "Composer",
  render: () => (
    <div className="w-[456px]">
      <Composer />
    </div>
  )
}

const DEMO_GITHUB: GitHubConnection = {
  mode: "connected",
  enabled: true,
  connected: true,
  user: { id: "1", login: "morganparry", name: "Morgan Parry", avatarUrl: null },
  installations: [{
    id: "101",
    account: { id: "1", login: "jingler", type: "Organization", avatarUrl: null },
    repositorySelection: "all",
    permissions: { contents: "write", pull_requests: "write" },
    status: "active",
    suspendedAt: null
  }],
  lastRefreshedAt: "2026-08-04T09:00:00.000Z",
  error: null
}

const DEMO_TABS: ReadonlyArray<TerminalTab> = [
  { id: "t1", title: "zsh", status: "running" },
  { id: "t2", title: "node", status: "idle" },
  { id: "t3", title: "bash", status: "exited" }
]

/** Interactive dock: flip sides, toggle visibility, switch tabs — exercises the
 * chrome/state seams (the live PTY cell is faked with a static block). */
function TerminalDockDemo() {
  const [dock, setDock] = useState<DockSide>("bottom")
  const [visible, setVisible] = useState(true)
  const [activeId, setActiveId] = useState<string | null>("t1")
  return (
    <div className="relative flex h-[560px] w-[1100px] overflow-hidden rounded-lg border border-line bg-editor">
      <div className="flex-1 p-4 text-sm text-ink-dim">
        Session workspace · dock is {dock}, {visible ? "visible" : "hidden"}
        <button className="ml-3 rounded border border-line px-2 py-0.5" onClick={() => setVisible((v) => !v)}>
          toggle (⌃`)
        </button>
      </div>
      <TerminalDock
        dock={dock}
        onDockChange={setDock}
        visible={visible}
        onToggle={() => setVisible(false)}
        tabs={DEMO_TABS}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={() => {}}
        onClose={() => {}}
        cwdLabel="~/repos/jingler"
        lastExit={0}
        renderTerminal={(id) => (
          <div className="h-full w-full p-3 font-mono text-xs text-ink">
            $ terminal cell for {id}
          </div>
        )}
      />
    </div>
  )
}

export const Terminal: Story = {
  name: "Terminal Dock",
  render: () => <TerminalDockDemo />
}

export const Settings: Story = {
  name: "Settings · Providers (E10)",
  render: () => (
    <div className="flex h-[760px] w-[1180px] overflow-hidden rounded-lg border border-line bg-editor">
      <SettingsView
        githubConnection={DEMO_GITHUB}
        github={{ enabled: true, autoCreatePr: false, autoDetectPr: true }}
        git={{ shareCheckedOutBranches: true }}
        onSaveGithub={() => {}}
        onSaveGit={() => {}}
        onClose={() => {}}
      />
    </div>
  )
}

export const SettingsNotificationsBlocked: Story = {
  name: "Settings · Notifications · Blocked by macOS (10.11)",
  render: () => (
    <div className="flex h-[760px] w-[1180px] overflow-hidden rounded-lg border border-line bg-editor">
      <SettingsView
        initialSection="notifications"
        githubConnection={DEMO_GITHUB}
        notificationPermission="denied"
        onOpenNotificationSystemSettings={() => {}}
        onClose={() => {}}
      />
    </div>
  )
}

const ComingSoon = ({ section }: { section: "permissions" | "keybindings" }) => (
  <div className="flex h-[760px] w-[1180px] overflow-hidden rounded-lg border border-line bg-editor">
    <SettingsView initialSection={section} githubConnection={DEMO_GITHUB} onClose={() => {}} />
  </div>
)

export const SettingsPermissionsComingSoon: Story = {
  name: "Settings · Permissions · Coming soon (10.20)",
  render: () => <ComingSoon section="permissions" />
}

export const SettingsKeybindingsComingSoon: Story = {
  name: "Settings · Keybindings · Coming soon (10.20)",
  render: () => <ComingSoon section="keybindings" />
}

const GeneralOffload = ({ status }: { status: "disabled" | "priming" | "ready" | "failed" }) => (
  <div className="flex h-[760px] w-[1180px] overflow-hidden rounded-lg border border-line bg-editor">
    <SettingsView
      initialSection="general"
      githubConnection={DEMO_GITHUB}
      offloadCompute={{ enabled: status !== "disabled", target: { kind: "cloud" }, explicitCommands: [] }}
      offloadStatus={status}
      onRetryOffload={() => {}}
      onClose={() => {}}
    />
  </div>
)

export const SettingsGeneralOffloadPriming: Story = {
  name: "Settings · General · Offload priming (10.2)",
  render: () => <GeneralOffload status="priming" />
}

export const SettingsGeneralOffloadReady: Story = {
  name: "Settings · General · Offload ready (10.2)",
  render: () => <GeneralOffload status="ready" />
}

export const SettingsGeneralOffloadFailed: Story = {
  name: "Settings · General · Offload failed + Retry (10.2)",
  render: () => <GeneralOffload status="failed" />
}

const CONTEXT_SESSIONS = [
  {
    id: "s1",
    title: "Fix PR inbox pagination",
    snapshot: {
      sessionId: "s1", tokens: 180_000, window: 1_000_000, budget: 300_000, triggerAt: 300_000,
      phase: "idle", preparing: false, digestReady: false, stalled: false
    }
  },
  {
    id: "s2",
    title: "Untracked scratch chat",
    snapshot: {
      sessionId: "s2", tokens: 0, window: null, budget: 300_000, triggerAt: null,
      phase: "unknown", preparing: false, digestReady: false, stalled: false
    }
  }
] as never

export const SettingsContext: Story = {
  name: "Settings · Context (10.16)",
  render: () => (
    <div className="flex h-[760px] w-[1180px] overflow-hidden rounded-lg border border-line bg-editor">
      <SettingsView
        initialSection="context"
        githubConnection={DEMO_GITHUB}
        context={{ auto: true, budgetTokens: 300_000 }}
        contextSessions={CONTEXT_SESSIONS}
        onSaveContext={() => {}}
        onClose={() => {}}
      />
    </div>
  )
}

export const SettingsPlan: Story = {
  name: "Settings · Plan (10.16)",
  render: () => (
    <div className="flex h-[760px] w-[1180px] overflow-hidden rounded-lg border border-line bg-editor">
      <SettingsView
        initialSection="plan"
        githubConnection={DEMO_GITHUB}
        planAutoRun
        planTemplate={{ source: "" }}
        onSavePlanAutoRun={() => {}}
        onSavePlanTemplate={() => {}}
        onClose={() => {}}
      />
    </div>
  )
}
