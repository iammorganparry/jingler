import type { Meta, StoryObj } from "@storybook/react-vite"
import { QueuedMessageRow } from "./queued-message-row.js"

const meta: Meta = { title: "QueuedMessageRow" }
export default meta
type Story = StoryObj

/** Idle queued message with all actions available. */
export const Idle: Story = {
  render: () => (
    <div className="w-[640px] space-y-2 bg-editor p-8">
      <QueuedMessageRow
        text="Rebase onto main"
        images={0}
        onSendNow={() => console.log("send now")}
        onHandoff={() => console.log("handoff")}
        onEdit={(text) => console.log("edit", text)}
        onRemove={() => console.log("remove")}
      />
    </div>
  )
}

/** Queued message with an image attachment. */
export const WithImage: Story = {
  render: () => (
    <div className="w-[640px] space-y-2 bg-editor p-8">
      <QueuedMessageRow
        text="What's wrong with this screenshot?"
        images={1}
        onSendNow={() => console.log("send now")}
        onHandoff={() => console.log("handoff")}
        onEdit={(text) => console.log("edit", text)}
        onRemove={() => console.log("remove")}
      />
    </div>
  )
}

/** Sending state — actions are hidden. */
export const Sending: Story = {
  render: () => (
    <div className="w-[640px] space-y-2 bg-editor p-8">
      <QueuedMessageRow
        text="Rebase onto main"
        images={0}
        sending
        onSendNow={() => console.log("send now")}
        onHandoff={() => console.log("handoff")}
        onEdit={(text) => console.log("edit", text)}
        onRemove={() => console.log("remove")}
      />
    </div>
  )
}

/** Multiple queued messages in the queue. */
export const Queue: Story = {
  render: () => (
    <div className="w-[640px] space-y-2 bg-editor p-8">
      <QueuedMessageRow
        text="Rebase onto main"
        images={0}
        onSendNow={() => console.log("send now")}
        onHandoff={() => console.log("handoff")}
        onEdit={(text) => console.log("edit", text)}
        onRemove={() => console.log("remove")}
      />
      <QueuedMessageRow
        text="Add unit tests for the new auth flow"
        images={0}
        onHandoff={() => console.log("handoff")}
        handoffHint="Hand off to Claude 3.7 Sonnet — run this in a new chat"
        onEdit={(text) => console.log("edit", text)}
        onRemove={() => console.log("remove")}
      />
      <QueuedMessageRow
        text="What does this error mean?"
        images={2}
        onHandoff={() => console.log("handoff")}
        onEdit={(text) => console.log("edit", text)}
        onRemove={() => console.log("remove")}
      />
    </div>
  )
}
