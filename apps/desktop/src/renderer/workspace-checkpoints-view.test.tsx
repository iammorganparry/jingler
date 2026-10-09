// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useState } from "react"
import { Schema } from "effect"
import { Session } from "@jingler/core"
import { afterEach, expect, it, vi } from "vitest"
import { WorkspaceCheckpointsView } from "./workspace-checkpoints-view.js"
const api = vi.hoisted(() => ({ list: vi.fn(), setMode: vi.fn(), capture: vi.fn(), preview: vi.fn(), restore: vi.fn() }))
vi.mock("./rpc-client.js", () => ({ rpc: {
  workspaceCheckpointsList: api.list, workspaceCheckpointsSetMode: api.setMode,
  workspaceCheckpointsCapture: api.capture, workspaceCheckpointsPreview: api.preview,
  workspaceCheckpointsRestore: api.restore,
} }))
const owner = Schema.decodeUnknownSync(Session)({ id: "owner", repo: "widget", branch: "main", title: "owner", status: "idle", diff: { added: 0, removed: 0 }, prNumber: null, costUsd: 0, tokens: 0, updatedAt: "now", chats: [], activeChatId: "chat", workspaceMode: "worktree", checkpointExecutionHistory: "clean" })
afterEach(() => { cleanup(); vi.resetAllMocks() })
it("keeps captured ownership through switches and preserves busy, consent and ready dismissal rules", async () => {
  let finish: ((items: []) => void) | undefined
  api.list.mockImplementationOnce(() => new Promise<[]>((resolve) => { finish = resolve })).mockResolvedValue([])
  function Host() {
    const [current, setCurrent] = useState("owner")
    const [request, setRequest] = useState<HTMLButtonElement | null>(null)
    return <>
      <button type="button" onClick={(event) => setRequest(event.currentTarget)}>More conversation actions</button>
      <button type="button" onClick={() => setCurrent("other-split-child")}>Switch session</button>
      <p>Visible: {current}</p>
      {request && <WorkspaceCheckpointsView session={owner} returnFocus={request} onSession={vi.fn()} onClosed={() => setRequest(null)} />}
    </>
  }
  render(<Host />)
  const trigger = screen.getByRole("button", { name: "More conversation actions" })
  fireEvent.click(trigger)
  const dialog = await screen.findByRole("dialog", { name: "Workspace checkpoints" })
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true)
  fireEvent.keyDown(dialog, { key: "Escape" })
  expect(screen.getByRole("dialog")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Switch session", hidden: true }))
  expect(screen.getByText("Visible: other-split-child")).toBeTruthy()
  await act(async () => { finish?.([]) })
  fireEvent.click(await screen.findByRole("button", { name: "Enable safe mode" }))
  fireEvent.keyDown(dialog, { key: "Escape" })
  await screen.findByRole("button", { name: "Enable safe mode" })
  expect(screen.getByRole("dialog")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Capture checkpoint" }))
  await waitFor(() => expect(api.capture).toHaveBeenCalledWith("owner"))
  await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", false))
  fireEvent.keyDown(dialog, { key: "Escape" })
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  await waitFor(() => expect(document.activeElement).toBe(trigger))
  expect(api.list.mock.calls.every(([id]) => id === "owner")).toBe(true)
})
