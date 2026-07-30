import type { Meta, StoryObj } from "@storybook/react-vite"
import { PlanDocEditor } from "./plan-doc/plan-doc-editor.js"

const planWithAssignment = ({
  status,
  agentId = "worker-core",
  cli = "codex",
  model = "gpt-5.6-sol",
  reason = "High-complexity route selected for the dependency group."
}: {
  status: "queued" | "running" | "blocked" | "failed" | "interrupted" | "completed"
  agentId?: string
  cli?: string
  model?: string
  reason?: string
}) => `<h1>PRD: Provider-neutral orchestration</h1>
<h2>Implementation</h2>
<section data-stage="03" data-title="Execute independent worker groups" data-depends-on="01 02" data-complexity="high">
<h3>Intent</h3>
<p>Run dependency-safe work through one stable logical agent.</p>
<div data-assignment data-agent-id="${agentId}" data-cli="${cli}" data-model="${model}" data-reason="${reason}" data-status="${status}"></div>
<h3>Approach</h3>
<ol><li>Reserve the worker.</li><li>Execute stages topologically.</li></ol>
<div data-acceptance="03.1" data-status="${status === "completed" ? "passed" : "pending"}">The worker route and lifecycle are visible.</div>
</section>`

const meta = {
  title: "Plan/Worker Assignment",
  component: PlanDocEditor,
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div className="h-[480px] w-[760px] overflow-hidden rounded-xl border border-line bg-canvas">
        <Story />
      </div>
    )
  ]
} satisfies Meta<typeof PlanDocEditor>

export default meta
type Story = StoryObj<typeof meta>

export const Running: Story = {
  args: {
    value: planWithAssignment({ status: "running" }),
    editable: false,
    workerControls: {
      stop: (agentId) => console.info("Stop worker", agentId)
    },
    className: "h-full"
  }
}

export const Failed: Story = {
  args: {
    value: planWithAssignment({
      status: "failed",
      cli: "claude",
      model: "claude-opus-4-1",
      reason: "The worker failed verification and can resume with its checkpoint."
    }),
    editable: false,
    workerControls: {
      retry: (agentId) => console.info("Retry worker", agentId)
    },
    className: "h-full"
  }
}

export const Completed: Story = {
  args: {
    value: planWithAssignment({
      status: "completed",
      cli: "opencode",
      model: "anthropic/claude-sonnet-4",
      reason: "All acceptance evidence passed for this worker group."
    }),
    editable: false,
    className: "h-full"
  }
}
