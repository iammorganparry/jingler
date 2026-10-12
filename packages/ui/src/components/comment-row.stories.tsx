import type { Meta, StoryObj } from "@storybook/react-vite"
import { Button } from "./button.js"
import { CommentRow } from "./comment-row.js"

const meta: Meta = { title: "Molecules/CommentRow" }
export default meta
type Story = StoryObj

/** Review findings as plain comment rows (boards 05, 17a). */
export const Findings: Story = {
  render: () => (
    <div className="w-[420px] bg-panel">
      <CommentRow severity="High" location="src/retry.ts:42" onDismiss={() => {}}
        action={<Button variant="secondary" size="sm">Ask agent to fix</Button>}>
        The retry loop never backs off, so a failing endpoint is hammered.
      </CommentRow>
      <CommentRow severity="Low" location="src/retry.ts:58" onDismiss={() => {}}>
        Rename `n` to `attempt` for clarity.
      </CommentRow>
    </div>
  )
}
