import type { Meta, StoryObj } from "@storybook/react-vite"
import { BackgroundTaskDock } from "./background-task-dock.js"
import type { BackgroundTask } from "@jingler/core"

const running: BackgroundTask = {
  id: "task-1",
  description: "Build workspace",
  status: "running",
  subagentType: "codex-exec-worker",
  startedAt: new Date(Date.now() - 8000).toISOString(),
  durationMs: 8000,
  toolUses: 3,
  tokens: 1200,
  lastTool: "workspace_write"
}

const done: BackgroundTask = {
  id: "task-2",
  description: "Lint & typecheck",
  status: "completed",
  startedAt: new Date(Date.now() - 120000).toISOString(),
  endedAt: new Date(Date.now() - 60000).toISOString(),
  durationMs: 60000,
  toolUses: 5,
  tokens: 800,
  summary: "All checks passed",
  outputFile: "/tmp/output.log"
}

const failed: BackgroundTask = {
  id: "task-3",
  description: "Run e2e tests",
  status: "failed",
  startedAt: new Date(Date.now() - 180000).toISOString(),
  endedAt: new Date(Date.now() - 90000).toISOString(),
  durationMs: 90000,
  toolUses: 12,
  tokens: 2400,
  summary: "3 tests failed"
}

const meta = {
  title: "Composite/Background Task Dock",
  component: BackgroundTaskDock,
  parameters: { layout: "fullscreen" },
  decorators: [(Story) => <div className="flex h-screen flex-col bg-editor"><div className="flex-1" /><Story /></div>]
} satisfies Meta<typeof BackgroundTaskDock>
export default meta
type Story = StoryObj<typeof meta>

export const Mixed: Story = {
  args: {
    tasks: [running, done, failed],
    onStop: (id) => console.log("stop", id),
    onView: (id) => console.log("view", id),
    onDismiss: (id) => console.log("dismiss", id)
  }
}

export const RunningOnly: Story = {
  args: {
    tasks: [running],
    onStop: (id) => console.log("stop", id)
  }
}
