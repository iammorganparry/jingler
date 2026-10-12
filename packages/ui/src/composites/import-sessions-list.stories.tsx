import type { Meta, StoryObj } from "@storybook/react-vite"
import type { ImportableSession } from "@jingler/core"
import { ImportSessionsList, importSessionKey } from "./import-sessions-list.js"

const session = (overrides: Partial<ImportableSession> & { nativeSessionId: string }): ImportableSession => ({
  source: "claude-code",
  harness: "claude",
  cwd: "/Users/dev/jingler",
  branch: "main",
  title: "Fix flaky sidebar test",
  updatedAt: "2026-10-01T10:00:00.000Z",
  messageCount: 12,
  folderExists: true,
  ...overrides
})

const many: ImportableSession[] = [
  session({ nativeSessionId: "c1" }),
  session({ nativeSessionId: "c2", title: "Add rate limiting", cwd: "/Users/dev/api", branch: "feat/rate-limit" }),
  session({ nativeSessionId: "c3", title: "Refactor auth", alreadyImported: true }),
  session({ source: "codex", harness: "codex", nativeSessionId: "x1", title: "Migrate to Effect", cwd: "/Users/dev/api" }),
  session({ source: "conductor", nativeSessionId: "d1", title: "Draft release notes", cwd: "/Users/dev/docs" })
]

const meta = {
  title: "Composites/ImportSessionsList",
  component: ImportSessionsList,
  parameters: { layout: "centered" },
  args: {
    candidates: many,
    status: "ready",
    query: "",
    selected: new Set<string>(),
    onQueryChange: () => {},
    onToggle: () => {},
    onImport: () => {},
    onSkip: () => {},
    onRetry: () => {}
  }
} satisfies Meta<typeof ImportSessionsList>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = { args: { candidates: [] } }
export const Loading: Story = { args: { status: "loading" } }
export const Many: Story = {}
export const FolderMissing: Story = {
  args: { candidates: [session({ nativeSessionId: "m1", title: "Old prototype", cwd: "/Users/dev/gone", folderExists: false })] }
}
export const Selected: Story = {
  args: { selected: new Set(many.slice(0, 2).map(importSessionKey)) }
}
