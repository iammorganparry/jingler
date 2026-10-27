import type { Meta, StoryObj } from "@storybook/react-vite"
import { ClaudeGlyph } from "./eyebrow.js"
import { AsyncButton } from "./async-button.js"
import { EmptyState, IndeterminateBar, InlineError, InlineStatus, ListSkeleton } from "./feedback.js"
import { Button } from "./button.js"

const meta: Meta = { title: "Feedback" }
export default meta
type Story = StoryObj

const wait = (ms: number, fail = false) =>
  new Promise<void>((resolve, reject) => setTimeout(() => (fail ? reject(new Error("nope")) : resolve()), ms))

/** AsyncButton: idle → pending spinner → success check → auto-reset. */
export const AsyncButtons: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3 bg-editor p-8">
      <AsyncButton
        icon={<ClaudeGlyph />}
        pendingLabel="Sending…"
        successLabel="Sent"
        onClick={() => wait(900)}
      >
        Send to agent
      </AsyncButton>
      <AsyncButton
        variant="secondary"
        pendingLabel="Opening…"
        successLabel="Opened"
        onClick={() => wait(900)}
      >
        Create PR
      </AsyncButton>
      <AsyncButton variant="danger" errorLabel="Failed, retry" onClick={() => wait(900, true)}>
        Will fail
      </AsyncButton>
      {/* Terminal: holds the "Sent" state — can't be re-fired. */}
      <AsyncButton icon={<ClaudeGlyph />} terminal done successLabel="Sent" onClick={() => wait(0)}>
        Send to agent
      </AsyncButton>
    </div>
  )
}

/** InlineStatus: the async feedback line variants. */
export const InlineStatuses: Story = {
  render: () => (
    <div className="flex flex-col gap-3 bg-editor p-8">
      <InlineStatus variant="loading">Saving changes…</InlineStatus>
      <InlineStatus variant="thinking">Claude is thinking</InlineStatus>
      <InlineStatus variant="success">Saved · just now</InlineStatus>
      <InlineStatus variant="error">Couldn&apos;t save — offline</InlineStatus>
    </div>
  )
}

/** IndeterminateBar: unknown-duration sweep + determinate fill. */
export const Bars: Story = {
  render: () => (
    <div className="flex w-[320px] flex-col gap-5 bg-editor p-8">
      <IndeterminateBar />
      <IndeterminateBar progress={0.64} tone="bg-green" />
    </div>
  )
}

/** ListSkeleton: loading rows at real row height. */
export const ListLoading: Story = {
  render: () => <div className="w-72 bg-editor p-4"><ListSkeleton rows={5} rowHeight={32} /></div>
}

/** EmptyState: what is missing + next action. */
export const ListEmpty: Story = {
  render: () => (
    <div className="w-72 bg-editor">
      <EmptyState title="No open pull requests" description="Open one from a session to see it here." action={<Button variant="secondary" size="sm">Create PR</Button>} />
    </div>
  )
}

/** InlineError: message + Retry. */
export const ListError: Story = {
  render: () => <div className="w-72 bg-editor"><InlineError message="Couldn't load pull requests" onRetry={() => undefined} /></div>
}
