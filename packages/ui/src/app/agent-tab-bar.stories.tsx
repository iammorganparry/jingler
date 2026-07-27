import type { ReactNode } from "react"
import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  ChatTabBar,
  MAIN_AGENT,
  SubagentTabBar,
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
    hasChildren: false
  },
  {
    id: "t2",
    name: "general-purpose",
    description: "Adversarial review",
    status: "working",
    hasChildren: true
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
    <SubagentTabBar
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
