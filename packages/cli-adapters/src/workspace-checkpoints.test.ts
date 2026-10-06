import { Schema } from "effect"
import { Session } from "@jingler/core"
import { afterEach, expect, it } from "vitest"
import { acquireCheckpointedTurn } from "./workspace-checkpoints.js"
import { acquireWorkspaceActivity, acquireWorkspaceToolActivity, checkpointTurnOwner, resetWorkspaceAdmissions, workspaceActivityCount } from "./workspace-admission.js"
const session = (extra: Record<string, unknown> = {}) => Schema.decodeUnknownSync(Session)({ id: "test", repo: "test", branch: "main", title: "test", status: "idle", diff: { added: 0, removed: 0 }, prNumber: null, costUsd: 0, tokens: 0, updatedAt: "now", chats: [{ id: "pi", title: null, createdAt: "now", updatedAt: "now", mode: "auto", runtimeId: "pi" }, { id: "native", title: null, createdAt: "now", updatedAt: "now", mode: "auto", runtimeId: "codex" }], activeChatId: "pi", workspaceMode: "worktree", worktreePath: "/missing", checkpointExecutionHistory: "clean", ...extra })
afterEach(resetWorkspaceAdmissions)
it("default OFF preserves parallel turns regardless of legacy history", async () => {
  const first = await acquireCheckpointedTurn(session({ checkpointExecutionHistory: undefined }), "/missing")
  const second = await acquireCheckpointedTurn(session(), "/missing")
  expect(workspaceActivityCount("test")).toBe(2); first.release(); second.release()
})
it("checks the actual requested inactive native chat before capture", async () => {
  await expect(acquireCheckpointedTurn(session({ checkpointSafeMode: true }), "/missing", "native")).rejects.toThrow("managed Pi")
})
it("legacy and unsupported history never enable a checkpoint turn", async () => {
  for (const history of [undefined, "unprovable"]) await expect(acquireCheckpointedTurn(session({ checkpointSafeMode: true, checkpointExecutionHistory: history }), "/missing")).rejects.toThrow("prior or unknown")
})
it("capture failure blocks execution, releases closure, and supports Retry", async () => {
  for (let attempt = 0; attempt < 2; attempt++) await expect(acquireCheckpointedTurn(session({ checkpointSafeMode: true }), "/missing")).rejects.toThrow("turn was blocked")
  expect(checkpointTurnOwner("test")).toBeUndefined(); expect(workspaceActivityCount("test")).toBe(0)
})
it("active work is refused without releasing or killing it", async () => {
  const active = acquireWorkspaceActivity("test", "terminal")
  await expect(acquireCheckpointedTurn(session({ checkpointSafeMode: true }), "/missing")).rejects.toThrow("Stop active work")
  expect(workspaceActivityCount("test")).toBe(1); active.release()
})
it("ownerless tools cannot bypass safe-mode admission", async () => {
  await expect(acquireCheckpointedTurn(session({ checkpointSafeMode: true }), "/missing")).rejects.toThrow()
  expect(() => acquireWorkspaceToolActivity("test")).toThrow("owner tool")
})
