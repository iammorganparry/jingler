import type { Meta, StoryObj } from "@storybook/react-vite"
import { useMachine } from "@xstate/react"
import { Button } from "./button.js"
import { Toast, ToastRegion } from "./toast.js"
import { toastMachine, type ToastInput } from "./toast-machine.js"

const meta = { title: "Atoms/Toast", component: Toast } satisfies Meta<typeof Toast>
export default meta
type Story = StoryObj<typeof meta>

const noop = () => {}

export const Success: Story = { args: { variant: "success", title: "Branch pushed", description: "feat/redesign-2.4-toast", onDismiss: noop } }
export const ErrorWithRetry: Story = {
  args: { variant: "error", title: "Push failed", description: "Remote rejected the update.", action: { label: "Retry", onAction: noop }, onDismiss: noop }
}
export const NeedsYou: Story = {
  args: { variant: "needs-you", title: "Agent needs approval", description: "Run pnpm test --filter ui", action: { label: "Jump", onAction: noop }, onDismiss: noop }
}
export const Info: Story = { args: { variant: "info", title: "3 messages handed off", action: { label: "View", onAction: noop }, onDismiss: noop } }

const samples: ReadonlyArray<ToastInput> = [
  { key: "pushed", variant: "success", title: "Branch pushed" },
  { key: "failed", variant: "error", title: "Push failed", action: { label: "Retry", onAction: noop } },
  { key: "needs", variant: "needs-you", title: "Agent needs approval", action: { label: "Jump", onAction: noop } },
  { key: "info", variant: "info", title: "3 messages handed off", action: { label: "View", onAction: noop } }
]

/** Live queue: max 3 visible, 6 s timeout, hover pauses. */
export const StackedQueue: Story = {
  args: Info.args,
  render: () => {
    const [snapshot, send] = useMachine(toastMachine, { input: undefined })
    return (
      <div className="relative h-[420px] w-[560px]">
        <div className="flex flex-wrap gap-2">
          {samples.map((toast) => (
            <Button key={toast.key} variant="secondary" size="sm" onClick={() => send({ type: "PUSH", toast })}>
              Push {toast.key}
            </Button>
          ))}
        </div>
        <ToastRegion
          className="absolute"
          toasts={snapshot.context.toasts}
          onDismiss={(key) => send({ type: "DISMISS", key })}
          onPause={() => send({ type: "PAUSE" })}
          onResume={() => send({ type: "RESUME" })}
        />
      </div>
    )
  }
}
