import type { ReactNode } from "react"
import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  AgentTabBar,
  ChatTabBar,
  MAIN_AGENT,
  type AgentTabItem,
  type ChatTabItem
} from "./agent-tab-bar.js"

const meta = {
  title: "App/AgentTabBar",
  component: ChatTabBar
} satisfies Meta<typeof ChatTabBar>

export default meta
type Story = StoryObj<typeof meta>

const CHATS: ReadonlyArray<ChatTabItem> = [
  { id: "c1", title: "Implement parser" },
  { id: "c2", title: "Review migrations", running: true },
  { id: "c3", title: "Check accessibility" }
]

/**
 * `ChatTabBar` is a FRAGMENT — it renders straight into `TabBar`'s `chatSlot`,
 * inheriting that row's gap, alignment and single horizontal scroll. So every
 * story here supplies the row it would otherwise be missing; rendered bare, the
 * pills would inherit whatever Storybook's canvas happens to be.
 */
function Row({ children }: { children: ReactNode }) {
  return (
    <div className="sb-no-scrollbar flex h-10 items-center gap-0.5 overflow-x-auto border-b border-hairline bg-sunken px-2">
      {children}
    </div>
  )
}

/** Select, create, close, or double-click a title to rename it. */
export const Interactive: Story = {
  args: {
    chats: CHATS,
    activeChatId: "c1",
    onSelectChat: () => {},
    onCreateChat: () => {},
    onRenameChat: () => {},
    onCloseChat: () => {}
  },
  render: () => {
    const [chats, setChats] = useState(CHATS)
    const [activeChatId, setActiveChatId] = useState("c1")
    return (
      <Row>
      <ChatTabBar
        chats={chats}
        activeChatId={activeChatId}
        onSelectChat={setActiveChatId}
        onCreateChat={() => {
          const id = `c${chats.length + 1}`
          setChats((current) => [...current, { id, title: `Chat ${current.length + 1}` }])
          setActiveChatId(id)
        }}
        onRenameChat={(id, title) =>
          setChats((current) => current.map((chat) => chat.id === id ? { ...chat, title } : chat))
        }
        onCloseChat={(id) => {
          const next = chats.filter((chat) => chat.id !== id)
          setChats(next)
          if (id === activeChatId && next[0]) setActiveChatId(next[0].id)
        }}
      />
      </Row>
    )
  }
}

/** Enough cells to exercise horizontal overflow. */
export const Overflow: Story = {
  args: {
    chats: Array.from({ length: 12 }, (_, index) => ({
      id: `c${index + 1}`,
      title: `Investigation ${index + 1}`
    })),
    activeChatId: "c8",
    onSelectChat: () => {},
    onCreateChat: () => {},
    onRenameChat: () => {},
    onCloseChat: () => {}
  },
  render: (args) => (
    <Row>
      <ChatTabBar {...args} />
    </Row>
  )
}

/** Running state stays attached to its chat when another chat is active. */
export const Running: Story = {
  args: {
    chats: CHATS,
    activeChatId: "c3",
    onSelectChat: () => {},
    onCreateChat: () => {},
    onRenameChat: () => {},
    onCloseChat: () => {}
  },
  render: (args) => (
    <Row>
      <ChatTabBar {...args} />
    </Row>
  )
}

const AGENTS: ReadonlyArray<AgentTabItem> = [
  {
    id: "t1",
    name: "Explore",
    description: "Map the RPC surface",
    status: "done",
    hasChildren: false,
    action: "close"
  },
  {
    id: "t2",
    name: "general-purpose",
    description: "Adversarial review",
    status: "working",
    hasChildren: true,
    action: "stop"
  }
]

/** Sub-agent drill-in remains beneath the selected top-level chat. */
export const SubagentDrillIn: Story = {
  args: {
    chats: CHATS,
    activeChatId: "c1",
    onSelectChat: () => {},
    onCreateChat: () => {},
    onRenameChat: () => {},
    onCloseChat: () => {}
  },
  render: () => (
    <AgentTabBar
      agents={AGENTS}
      trail={[]}
      active={MAIN_AGENT}
      onChange={() => {}}
      onDrill={() => {}}
      onNavigate={() => {}}
      onStop={() => {}}
      onClose={() => {}}
    />
  )
}

const WORKERS: ReadonlyArray<AgentTabItem> = [
  {
    id: "worker-auth",
    name: "worker-auth",
    description: "claude · opus · 7 stages · attempt 1",
    status: "running",
    hasChildren: false,
    action: "stop"
  },
  {
    id: "worker-release",
    name: "worker-release",
    description: "codex · gpt-5.6-sol · 1 stage · attempt 1",
    status: "queued",
    hasChildren: false
  },
  {
    id: "worker-tests",
    name: "worker-tests",
    description: "claude · opus · 2 stages · attempt 2",
    status: "blocked",
    hasChildren: false
  },
  {
    id: "worker-failed",
    name: "worker-failed",
    description: "codex · gpt-5.6-sol · 1 stage · attempt 1",
    status: "failed",
    hasChildren: false
  },
  {
    id: "worker-stopped",
    name: "worker-stopped",
    description: "claude · opus · 1 stage · attempt 1",
    status: "interrupted",
    hasChildren: false
  },
  {
    id: "worker-done",
    name: "worker-done",
    description: "codex · gpt-5.6-sol · 3 stages · attempt 1",
    status: "completed",
    hasChildren: false
  }
]

/** Every provider-neutral worker lifecycle in the shared top-level rail. */
export const OrchestrationWorkers: Story = {
  args: {
    chats: CHATS,
    activeChatId: "c1",
    onSelectChat: () => {},
    onCreateChat: () => {},
    onRenameChat: () => {},
    onCloseChat: () => {}
  },
  render: () => (
    <AgentTabBar
      agents={WORKERS}
      trail={[]}
      active="worker-auth"
      onChange={() => {}}
      onDrill={() => {}}
      onNavigate={() => {}}
      onStop={() => {}}
      onClose={() => {}}
    />
  )
}
