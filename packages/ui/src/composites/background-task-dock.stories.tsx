import type { Meta, StoryObj } from "@storybook/react-vite"
import { BackgroundTaskDock } from "./background-task-dock.js"
import type { BackgroundTask } from "@jingler/core"

const running: BackgroundTask = {
  id: "task-1",
  sessionId: "session-1",
  description: "Build workspace",
  taskType: "subagent",
  subagentType: "codex-exec-worker",
  status: "running",
  toolUseId: null,
  startedAt: new Date(Date.now() - 8000).toISOString(),
  endedAt: null,
  durationMs: 8000,
  toolUses: 3,
  tokens: 1200,
  lastTool: "workspace_write",
  summary: null,
  outputFile: null
}

const done: BackgroundTask = {
  id: "task-2",
  sessionId: "session-1",
  description: "Lint & typecheck",
  taskType: "bash",
  subagentType: null,
  status: "completed",
  toolUseId: null,
  startedAt: new Date(Date.now() - 120000).toISOString(),
  endedAt: new Date(Date.now() - 60000).toISOString(),
  durationMs: 60000,
  toolUses: 5,
  tokens: 800,
  lastTool: null,
  summary: "All checks passed",
  outputFile: "/tmp/output.log"
}

const failed: BackgroundTask = {
  id: "task-3",
  sessionId: "session-1",
  description: "Run e2e tests",
  taskType: "bash",
  subagentType: null,
  status: "failed",
  toolUseId: null,
  startedAt: new Date(Date.now() - 180000).toISOString(),
  endedAt: new Date(Date.now() - 90000).toISOString(),
  durationMs: 90000,
  toolUses: 12,
  tokens: 2400,
  lastTool: null,
  summary: "3 tests failed",
  outputFile: null
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
