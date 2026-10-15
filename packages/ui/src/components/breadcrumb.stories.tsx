import type { Meta, StoryObj } from "@storybook/react-vite"
import { AgentEditsMarker, Breadcrumb } from "./breadcrumb.js"

const meta = {
  title: "Components/Breadcrumb",
  component: Breadcrumb,
  args: { crumbs: ["packages", "ui", "src", "composites", "session-row.tsx"] }
} satisfies Meta<typeof Breadcrumb>

export default meta
type Story = StoryObj<typeof meta>

export const Plain: Story = {}

export const WithAgentEdits: Story = {
  render: (args) => (
    <Breadcrumb {...args}>
      <AgentEditsMarker count={2} />
    </Breadcrumb>
  )
}
