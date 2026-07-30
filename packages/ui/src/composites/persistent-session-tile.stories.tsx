import type { Meta, StoryObj } from "@storybook/react-vite"
import { testSession } from "../test-support.js"
import { PersistentSessionTile } from "./persistent-session-tile.js"

const meta = {
  title: "Composites/PersistentSessionTile",
  component: PersistentSessionTile,
  decorators: [
    (Story) => (
      <div className="w-[92px] bg-panel p-2">
        <Story />
      </div>
    )
  ]
} satisfies Meta<typeof PersistentSessionTile>

export default meta
type Story = StoryObj<typeof meta>

export const Idle: Story = {
  args: {
    session: testSession({
      id: "kept",
      title: "Auth",
      persistent: true,
      cli: "claude"
    }),
    onSelect: () => {},
    onUnpersist: () => {},
    onArchive: () => {},
    onDelete: () => {}
  }
}

export const ActiveAndRunning: Story = {
  args: {
    ...Idle.args,
    session: testSession({
      id: "running",
      title: "Tests",
      persistent: true,
      cli: "codex"
    }),
    activity: {
      kind: "running",
      verb: "Running",
      target: "pnpm test"
    },
    active: true
  }
}

export const NeedsInput: Story = {
  args: {
    ...Idle.args,
    session: testSession({
      id: "input",
      title: "Review",
      persistent: true,
      cli: "opencode"
    }),
    activity: {
      kind: "needs-approval",
      verb: "Needs approval",
      target: null
    }
  }
}
