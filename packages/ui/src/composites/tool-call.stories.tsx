import type { Meta, StoryObj } from "@storybook/react-vite"
import { ToolCall, toolCallLabel } from "./tool-call.js"

const meta: Meta = { title: "Molecules/Work mode tool call" }
export default meta
type Story = StoryObj

const refusal = "forbidden: Cannot switch to build: submit the plan with plannotator_submit_plan for approval first"

function WorkModeCard({ mode, reason, error }: { mode: "plan" | "build"; reason: string; error?: string }) {
  const { title } = toolCallLabel({ toolName: "jingler_set_work_mode", args: { mode, reason } })
  return (
    <ToolCall status={error ? "error" : "success"} name="Work mode" target={title} expanded={error !== undefined} onToggle={() => {}}>
      {error ? <pre className="border-t border-line bg-editor px-3 py-2 font-mono text-[11px] text-state-failed">{error}</pre> : null}
    </ToolCall>
  )
}

export const EnteredPlan: Story = { render: () => <div className="w-96"><WorkModeCard mode="plan" reason="large refactor" /></div> }
export const SwitchedToBuild: Story = { render: () => <div className="w-96"><WorkModeCard mode="build" reason="plan approved" /></div> }
export const Refused: Story = { render: () => <div className="w-96"><WorkModeCard mode="build" reason="start coding" error={refusal} /></div> }
