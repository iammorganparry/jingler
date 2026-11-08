import type { Meta, StoryObj } from "@storybook/react-vite"
import type { Message } from "@jingler/core"
import { ConversationView } from "./conversation-view.js"

const messages: Message[] = [
  { id: "question", role: "user", streaming: false, createdAt: "2026-11-05T00:00:00Z", parts: [{ _tag: "Text", text: "What caused the reconnect failure?" }] },
  { id: "answer", role: "assistant", streaming: false, createdAt: "2026-11-05T00:00:01Z", parts: [{ _tag: "Text", text: "The **connection pool timeout** comes from a stale socket. Clear the pool before retrying, then open a fresh connection.\n\nKeep the retry budget unchanged." }] }
]
const meta = {
  title: "App/ConversationSearch",
  component: ConversationView,
  args: { messages, mode: "auto", focusMessageIndex: 1, searchQuery: "connection pool timeout" },
  render: (args) => <div className="flex h-[640px] bg-panel"><ConversationView {...args} /></div>
} satisfies Meta<typeof ConversationView>
export default meta
type Story = StoryObj<typeof meta>

/** The native highlight paints only the phrase; Markdown retains its original layout. */
export const SavedMessage: Story = {}

export const AgentRecall: Story = {
  args: {
    focusMessageIndex: undefined,
    searchQuery: undefined,
    messages: [{
      id: "recall", role: "assistant", streaming: false, createdAt: "2026-11-05T00:00:01Z",
      parts: [
        { _tag: "Tool", tool: { id: "search", name: "conversation_search", target: null, status: "success", meta: null, diff: null, preview: null, output: "Found the earlier reconnect discussion." } },
        { _tag: "Tool", tool: { id: "read", name: "conversation_read", target: null, status: "success", meta: null, diff: null, preview: null, output: "Reset the shared pool before reconnecting." } },
        { _tag: "Text", text: "The earlier investigation found a stale socket. Reset the shared pool before reconnecting." }
      ]
    }]
  }
}
