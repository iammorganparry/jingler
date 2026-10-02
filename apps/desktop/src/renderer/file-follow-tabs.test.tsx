// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("./rpc-client.js", () => ({
  rpc: {
    assetList: vi.fn().mockResolvedValue([{ path: "src/app.ts", status: "modified" }]),
    sessionsFileDiff: vi.fn().mockResolvedValue({ kind: "patch", patch: "" }),
    assetRead: vi.fn().mockImplementation((_sessionId: string, path: string) => Promise.resolve({
      path, absolutePath: `/worktree/${path}`, size: 6, kind: "code",
      language: "typescript", text: "before", revision: "before"
    }))
  }
}))

import { disposeFileBrowserActor, openSessionFileDiff, useFileBrowser } from "./use-file-browser.js"

afterEach(() => {
  cleanup()
  disposeFileBrowserActor("follow-tabs")
})

describe("followed file tabs", () => {
  it("carries the completed target into its file tab without redirecting another tab", async () => {
    const { result } = renderHook(() => ({
      first: useFileBrowser("follow-tabs", "/worktree", "file:src/app.ts"),
      second: useFileBrowser("follow-tabs", "/worktree", "file:src/next.ts")
    }))
    act(() => openSessionFileDiff("follow-tabs", "/worktree", "src/app.ts", {
      eventId: "edit-1", preview: "first preview", completed: true
    }))
    await waitFor(() => expect(result.current.first.status).toBe("clean"))
    expect(result.current.first).toMatchObject({
      selectedPath: "src/app.ts", viewMode: "diff", followEnabled: true,
      agentTargetPath: "src/app.ts", agentTargetEventId: "edit-1", agentTargetCompleted: true
    })
    act(() => openSessionFileDiff("follow-tabs", "/worktree", "src/next.ts", {
      eventId: "edit-2", preview: "next preview", completed: true
    }))
    await waitFor(() => expect(result.current.second.status).toBe("clean"))
    expect(result.current.first.selectedPath).toBe("src/app.ts")
    expect(result.current.second.agentTargetEventId).toBe("edit-2")
  })

  it("still disables session Follow when the operator edits the followed file", async () => {
    const { result } = renderHook(() => ({
      session: useFileBrowser("follow-tabs", "/worktree"),
      file: useFileBrowser("follow-tabs", "/worktree", "file:src/app.ts")
    }))
    act(() => {
      result.current.session.enableFollow()
      openSessionFileDiff("follow-tabs", "/worktree", "src/app.ts", {
        eventId: "edit-1", completed: true
      })
    })
    await waitFor(() => expect(result.current.file.status).toBe("clean"))
    act(() => result.current.file.edit("operator change"))
    expect(result.current.file.draft).toBe("operator change")
    expect(result.current.file.followEnabled).toBe(false)
    expect(result.current.session.followEnabled).toBe(false)
  })
})
