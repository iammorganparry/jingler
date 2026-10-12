import type { Meta, StoryObj } from "@storybook/react-vite"
import { PreviewRail } from "./overlays.js"

const meta = {
  title: "BeUI/PreviewRail",
  component: PreviewRail,
  parameters: { layout: "fullscreen" }
} satisfies Meta<typeof PreviewRail>

export default meta
type Story = StoryObj<typeof meta>

const makeItems = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `turn-${i}`,
    label: `Turn ${i + 1}`,
    description: `This is turn ${i + 1} with some longer description text to show in the preview card.`
  }))

export const Short: Story = {
  args: {
    items: makeItems(8),
    maxItems: 10,
    highlightActive: true,
    activeId: "turn-4"
  }
}

export const LongActiveStart: Story = {
  args: {
    items: makeItems(40),
    maxItems: 10,
    highlightActive: true,
    activeId: "turn-2"
  }
}

export const LongActiveMiddle: Story = {
  args: {
    items: makeItems(40),
    maxItems: 10,
    highlightActive: true,
    activeId: "turn-20"
  }
}

export const LongActiveEnd: Story = {
  args: {
    items: makeItems(40),
    maxItems: 10,
    highlightActive: true,
    activeId: "turn-37"
  }
}

export const VeryLong: Story = {
  args: {
    items: makeItems(200),
    maxItems: 10,
    highlightActive: true,
    activeId: "turn-100"
  }
}
