import type { Meta, StoryObj } from "@storybook/react-vite"
import { ChatLaneHeader } from "./chat-lane-header.js"

const meta = {
  title: "App/ChatLaneHeader",
  component: ChatLaneHeader,
  parameters: {
    layout: "fullscreen"
  },
  args: {
    onSelectChat: () => {},
    onCreateChat: () => {},
    onToggleFollowAgent: () => {}
  }
} satisfies Meta<typeof ChatLaneHeader>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    chats: [
      { id: "chat-1", title: "Main workspace" },
      { id: "chat-2", title: "Review migrations" },
      { id: "chat-3", title: "Fix tests", running: true }
    ],
    activeChatId: "chat-1",
    followAgent: false
  }
}

export const SingleChat: Story = {
  args: {
    chats: [{ id: "chat-1", title: "Main workspace" }],
    activeChatId: "chat-1"
  }
}

export const RunningChat: Story = {
  args: {
    chats: [
      { id: "chat-1", title: "Implementing feature X", running: true },
      { id: "chat-2", title: "Review migrations" }
    ],
    activeChatId: "chat-1"
  }
}

export const FollowAgentEnabled: Story = {
  args: {
    chats: [
      { id: "chat-1", title: "Main workspace" },
      { id: "chat-2", title: "Review migrations" }
    ],
    activeChatId: "chat-1",
    followAgent: true
  }
}

export const WithoutFollowToggle: Story = {
  args: {
    chats: [
      { id: "chat-1", title: "Main workspace" },
      { id: "chat-2", title: "Review migrations" }
    ],
    activeChatId: "chat-1",
    onToggleFollowAgent: undefined
  }
}

export const LongChatTitle: Story = {
  args: {
    chats: [
      {
        id: "chat-1",
        title: "Implementing a very long feature name that should truncate gracefully in the UI"
      },
      { id: "chat-2", title: "Review migrations" }
    ],
    activeChatId: "chat-1"
  }
}
