// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { Schema } from "effect"
import { Session } from "@jingler/core"
import { afterEach, expect, it, vi } from "vitest"
import { WorkspaceWorkflowBar } from "./workspace-workflow-bar.js"
const listRuns = vi.hoisted(() => vi.fn())
vi.mock("./rpc-client.js", () => ({ rpc: { workspaceWorkflowListRuns: listRuns } }))
const session = Schema.decodeUnknownSync(Session)({ id: "owner", repo: "widget", branch: "main", title: "owner", status: "idle", diff: { added: 0, removed: 0 }, prNumber: null, costUsd: 0, tokens: 0, updatedAt: "now", chats: [], activeChatId: "chat", workspaceMode: "worktree", workspaceLifecycle: { status: "ready", updatedAt: "now" } })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks() })
it("hides an empty ready worktree bar and keeps polling for orphan runs and failure diagnostics", async () => {
  listRuns.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "orphan", label: "Orphan", status: "running" }]).mockResolvedValue([{ id: "orphan", label: "Orphan", status: "failed", output: "crashed" }])
  render(<WorkspaceWorkflowBar session={session} onSession={vi.fn()} onPreview={vi.fn()} />)
  await waitFor(() => expect(listRuns).toHaveBeenCalledWith("owner"))
  expect(screen.queryByTestId("workspace-workflow-bar")).toBeNull()
  await screen.findByRole("button", { name: "Stop Orphan" }, { timeout: 3500 })
  await screen.findByText("Orphan failed", {}, { timeout: 3500 })
  expect(screen.getByText("crashed")).toBeTruthy()
})
