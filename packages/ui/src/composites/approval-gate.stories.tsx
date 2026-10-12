import type { Meta, StoryObj } from "@storybook/react-vite"
import { ApprovalGate } from "./approval-gate.js"

const meta = {
  title: "Composites/ApprovalGate",
  component: ApprovalGate,
  parameters: { layout: "centered" }
} satisfies Meta<typeof ApprovalGate>

export default meta
type Story = StoryObj<typeof meta>

export const CommandPending: Story = {
  args: {
    kind: "command",
    title: "Run command",
    detail: "Agent wants to run a shell command in your workspace",
    command: "pnpm test --filter @jingler/ui",
    status: "pending"
  }
}

export const LongCommandPending: Story = {
  args: {
    kind: "command",
    title: "Run pnpm --filter @jingler/desktop …?",
    detail: "Agent wants to run a shell command in your workspace",
    command: "pnpm --filter @jingler/desktop exec playwright test e2e/changes-review.spec.ts --project=electron --reporter=line --retries=0 && pnpm vitest run packages/cli-adapters/src/workspace --coverage --reporter=verbose && pnpm --filter @jingler/ui exec tsc --noEmit --pretty false",
    status: "pending"
  }
}

export const CommandAlwaysAllowed: Story = {
  args: {
    kind: "command",
    title: "Run command",
    detail: "Agent wants to run a shell command in your workspace",
    command: "pnpm test --filter @jingler/ui",
    allowLabel: "pnpm test",
    status: "pending"
  }
}

export const CommandApproved: Story = {
  args: {
    kind: "command",
    title: "Run command",
    detail: "Agent wants to run a shell command in your workspace",
    command: "pnpm build",
    status: "approved"
  }
}

export const CommandRejected: Story = {
  args: {
    kind: "command",
    title: "Run command",
    detail: "Agent wants to run a shell command in your workspace",
    command: "rm -rf node_modules",
    status: "rejected"
  }
}

export const EditPending: Story = {
  args: {
    kind: "edit",
    title: "Approve edit",
    detail: "Agent wants to modify packages/ui/src/components/button.tsx",
    status: "pending"
  }
}

export const PendingWithSwitchToAuto: Story = {
  args: {
    kind: "command",
    title: "Run pnpm test?",
    detail: "cwd ~/jingler",
    command: "pnpm --filter @jingler/desktop test",
    allowLabel: "pnpm test",
    status: "pending",
    onSwitchToAuto: () => undefined
  }
}
