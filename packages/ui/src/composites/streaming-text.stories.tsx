import type { Meta, StoryObj } from "@storybook/react-vite"
import { StreamingText } from "./streaming-text.js"

const meta = {
  title: "Conversation/Streaming Text",
  component: StreamingText,
  parameters: { layout: "centered" },
  decorators: [(Story) => <div className="w-[620px] bg-editor p-6 text-text-body"><Story /></div>]
} satisfies Meta<typeof StreamingText>
export default meta
type Story = StoryObj<typeof meta>

export const Active: Story = {
  args: {
    text: "Updating the plan chat now — the approval card is ready, task status is moving into the composer, and the final conversation treatment is streaming",
    streaming: true
  }
}

export const CompletedMarkdown: Story = {
  args: {
    text: "The update is **complete** and the finished response no longer shows a caret.",
    streaming: false
  }
}
