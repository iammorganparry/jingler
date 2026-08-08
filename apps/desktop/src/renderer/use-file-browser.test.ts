import { describe, expect, it, vi } from "vitest"
import { listRepositoryFiles } from "./repository-file-list.js"

describe("listRepositoryFiles", () => {
  it("uses the validated asset inventory when it contains repository files", async () => {
    const assetList = vi.fn().mockResolvedValue([
      { path: "src/main.ts", status: "modified" as const }
    ])
    const workspaceFiles = vi.fn().mockResolvedValue(["fallback.ts"])
    const sessionsGet = vi.fn()

    await expect(
      listRepositoryFiles(
        { assetList, sessionsGet, workspaceFiles },
        "session-1",
        "/worktree",
        10
      )
    ).resolves.toEqual([{ path: "src/main.ts", status: "modified" }])
    expect(sessionsGet).not.toHaveBeenCalled()
    expect(workspaceFiles).not.toHaveBeenCalled()
  })

  it("falls back to the core workspace inventory when Asset.list is empty", async () => {
    const assetList = vi.fn().mockResolvedValue([])
    const sessionsGet = vi.fn().mockResolvedValue({
      worktreePath: "/worktree"
    })
    const workspaceFiles = vi.fn().mockResolvedValue([
      "README.md",
      "packages/ui/src/index.ts"
    ])

    await expect(
      listRepositoryFiles(
        { assetList, sessionsGet, workspaceFiles },
        "session-1",
        "/worktree",
        10
      )
    ).resolves.toEqual([
      { path: "README.md", status: "clean" },
      { path: "packages/ui/src/index.ts", status: "clean" }
    ])
    expect(sessionsGet).toHaveBeenCalledWith("session-1")
    expect(workspaceFiles).toHaveBeenCalledWith("/worktree")
  })

  it("recovers the current worktree when the persistent actor was created before it existed", async () => {
    const assetList = vi.fn().mockResolvedValue([])
    const sessionsGet = vi.fn().mockResolvedValue({
      worktreePath: "/late-worktree"
    })
    const workspaceFiles = vi.fn().mockResolvedValue(["src/recovered.ts"])

    await expect(
      listRepositoryFiles(
        { assetList, sessionsGet, workspaceFiles },
        "session-1",
        undefined,
        10
      )
    ).resolves.toEqual([{ path: "src/recovered.ts", status: "clean" }])
    expect(sessionsGet).toHaveBeenCalledWith("session-1")
    expect(workspaceFiles).toHaveBeenCalledWith("/late-worktree")
  })

  it("falls back when the dedicated asset client does not settle", async () => {
    const assetList = vi.fn().mockReturnValue(new Promise(() => {}))
    const sessionsGet = vi.fn().mockResolvedValue({ worktreePath: "/worktree" })
    const workspaceFiles = vi.fn().mockResolvedValue(["src/recovered.ts"])

    await expect(
      listRepositoryFiles(
        { assetList, sessionsGet, workspaceFiles },
        "session-1",
        "/worktree",
        1
      )
    ).resolves.toEqual([{ path: "src/recovered.ts", status: "clean" }])
  })
})
