import type { Meta, StoryObj } from "@storybook/react-vite"
import type { ProviderId, Session, SessionActivity } from "@jingler/core"
import { useState } from "react"
import { createEditorLayout } from "./editor-layout.js"
import { initEditorLayout, resetEditorLayouts } from "./editor-layout-machine.js"
import { SessionSidebar } from "./session-sidebar.js"

const meta = {
  title: "App/SessionSidebar",
  component: SessionSidebar,
  parameters: { layout: "fullscreen" }
} satisfies Meta<typeof SessionSidebar>

export default meta
type Story = StoryObj<typeof meta>

const session = (over: Partial<Session> & Pick<Session, "id" | "title">): Session => ({
  repo: "jingler",
  branch: "chore/witty-berners",
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-07-17T10:00:00.000Z",
  chats: [{ id: `c_${over.id}_1`, title: null, createdAt: "2026-07-17T10:00:00.000Z", updatedAt: "2026-07-17T10:00:00.000Z" }],
  activeChatId: `c_${over.id}_1`,
  archived: false,
  ...over
})

/**
 * One session per reportable state, plus the two that used to leak their
 * innards. A row says one of five words and nothing else — the tool and its
 * target moved to the hover title, where they can't shove the branch name out of
 * the row.
 */
const SESSIONS: ReadonlyArray<Session> = [
  session({ id: "s1", title: "Refactor auth flow", repo: "jingler", diff: { added: 42, removed: 8 } }),
  session({ id: "s2", title: "Fix token refresh", repo: "jingler", prNumber: 47 }),
  session({ id: "s3", title: "Watch CI on #204", repo: "gtm-grid", prNumber: 204 }),
  session({ id: "s4", title: "Type-check watcher", repo: "gtm-grid" }),
  session({ id: "s5", title: "Awaiting approval", repo: "trigify-app" }),
  session({ id: "s6", title: "Big Triage", repo: "trigify-app", status: "idle" }),
  session({ id: "s7", title: "Finished run", repo: "trigify-app", status: "done" })
]

/**
 * The activities behind the rows. `s1`/`s2` carry a long target on purpose —
 * before, the row read "Running git branch --show-current" and ellipsized over
 * the branch; now both read "Running".
 */
const ACTIVITY: Record<string, SessionActivity> = {
  s1: { kind: "thinking", verb: "Thinking", target: null },
  s2: { kind: "running", verb: "Running", target: "git branch --show-current && pnpm test -- auth" },
  s3: { kind: "monitoring", verb: "Monitoring PR", target: "#204" },
  // A non-CI watcher — also Monitoring: it's a process that won't return.
  s4: { kind: "watching", verb: "Watching", target: "tsc --watch --preserveWatchOutput" },
  s5: { kind: "needs-approval", verb: "Needs approval", target: null }
}

/** Grouped by repo (the default) — every state visible at once. */
export const UpgradeAvailable: Story = {
  args: {
    sessions: SESSIONS,
    activeSessionId: "s1",
    onSelect: () => {},
    version: "0.2.1",
    update: {
      version: "0.3.0",
      status: "available",
      dismissed: false,
      onAction: () => {},
      onDismiss: () => {}
    }
  },
  render: (args) => (
    <div className="flex h-screen bg-editor">
      <SessionSidebar {...args} />
    </div>
  )
}

/** An unsigned build: the update opens the installer instead of restarting. */
export const UpgradeManual: Story = {
  args: {
    sessions: SESSIONS,
    activeSessionId: "s1",
    onSelect: () => {},
    version: "0.3.3",
    update: {
      version: "0.3.4",
      status: "available",
      manual: true,
      dismissed: false,
      onAction: () => {},
      onDismiss: () => {}
    }
  },
  render: (args) => (
    <div className="flex h-screen bg-editor">
      <SessionSidebar {...args} />
    </div>
  )
}

/** Relaunched on a new version: what changed since the last one that ran. */
export const UpdatedReleaseNotes: Story = {
  args: {
    sessions: SESSIONS,
    activeSessionId: "s1",
    onSelect: () => {},
    version: "0.3.0",
    releaseNotes: {
      version: "0.3.0",
      notes: [
        "Review changes in the Explorer, filtered to uncommitted or pull request files.",
        "Send review comments to the agent with the code they point at.",
        "Follow the agent into newly created files on their diff.",
        "Lay out split panes for their own width.",
        "Truncate long model names in the composer."
      ],
      onDismiss: () => {}
    }
  },
  render: (args) => (
    <div className="flex h-screen bg-editor">
      <SessionSidebar {...args} />
    </div>
  )
}

export const AllStates: Story = {
  args: {
    sessions: SESSIONS,
    activeSessionId: "s1",
    onSelect: () => {},
    liveActivity: ACTIVITY,
    version: "0.1.0"
  },
  render: (args) => (
    <div className="flex h-screen bg-editor">
      <SessionSidebar {...args} />
    </div>
  )
}

/**
 * A reading/editing session. Both report "Running" — the conversation header
 * keeps "Reading session.ts"; a row in a list has no room for the distinction
 * and no reader scanning the column wants it.
 */
export const ToolWorkAllReadsAsRunning: Story = {
  args: {
    sessions: [
      session({ id: "r1", title: "Reading", repo: "jingler" }),
      session({ id: "r2", title: "Editing", repo: "jingler" }),
      session({ id: "r3", title: "Delegating", repo: "jingler" }),
      session({ id: "r4", title: "Searching the web", repo: "jingler" })
    ],
    activeSessionId: "r1",
    onSelect: () => {},
    liveActivity: {
      r1: { kind: "reading", verb: "Reading", target: "conversation.ts" },
      r2: { kind: "editing", verb: "Editing", target: "session-row.tsx" },
      r3: { kind: "delegating", verb: "Delegating", target: "Explore the plan pane" },
      r4: { kind: "web", verb: "Searching the web", target: "effect schema optionalWith" }
    }
  },
  render: (args) => (
    <div className="flex h-screen bg-editor">
      <SessionSidebar {...args} />
    </div>
  )
}


const TREE_SESSION = session({
  id: "tree",
  title: "Editor navigation",
  repo: "jingler",
  branch: "feat/editor-groups",
  chats: [
    { id: "tree-main", title: "Navigation model", providerId: "anthropic" as ProviderId, createdAt: "2026-09-01T10:00:00.000Z", updatedAt: "2026-09-01T10:00:00.000Z" },
    { id: "tree-files", title: "File tabs", providerId: "openai-codex" as ProviderId, createdAt: "2026-09-01T10:01:00.000Z", updatedAt: "2026-09-01T10:01:00.000Z" },
    { id: "tree-perf", title: "Render performance", providerId: "google" as ProviderId, createdAt: "2026-09-01T10:02:00.000Z", updatedAt: "2026-09-01T10:02:00.000Z" }
  ],
  activeChatId: "tree-main"
})

function SessionTreePreview() {
  useState(() => {
    resetEditorLayouts()
    initEditorLayout(
      TREE_SESSION.id,
      createEditorLayout(
        [
          { kind: "chat", id: "tree-main" },
          { kind: "chat", id: "tree-files" },
          { kind: "file", id: "packages/ui/src/app/editor-groups.tsx" },
          { kind: "view", id: "terminal" },
          { kind: "view", id: "plan", chatId: "tree-main" }
        ],
        "tree-main"
      )
    )
  })
  return (
    <div className="flex h-screen bg-editor">
      <SessionSidebar
        sessions={[TREE_SESSION]}
        activeSessionId={TREE_SESSION.id}
        onSelect={() => {}}
        liveActivity={{ tree: { kind: "editing", verb: "Editing", target: "editor-groups.tsx" } }}
      />
      <div className="flex flex-1 items-center justify-center text-xs text-dim">Session editor layout</div>
    </div>
  )
}

/** The expanded session hierarchy with provider icons, chat-owned views, open files, and session views. */
export const ExpandedSessionTree: Story = {
  args: {
    sessions: [TREE_SESSION],
    activeSessionId: TREE_SESSION.id,
    onSelect: () => {}
  },
  render: () => <SessionTreePreview />
}
