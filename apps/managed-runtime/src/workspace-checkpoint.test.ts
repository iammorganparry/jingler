import { describe, expect, it, vi } from "vitest"
import {
  createWorkspaceCheckpoint,
  WORKSPACE_BACKUP_EXCLUDES,
  type CheckpointManifestStore,
  type CheckpointSandbox
} from "./workspace-checkpoint.js"

const digest = "a".repeat(64)
const archive = () => new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new Uint8Array([1, 2, 3]))
    controller.close()
  }
})

const sandbox = (): CheckpointSandbox => ({
  exec: vi.fn(async (command: string) => ({
    success: true,
    stdout: command.includes("rev-parse")
      ? `${"b".repeat(40)}\nfeature/cloud\n1\n1\n`
      : command.includes("find . -type d")
        ? "1024\n"
        : digest,
    stderr: ""
  })),
  readFile: vi.fn(async () => ({ success: true as const, content: archive(), size: 3 })),
  writeFile: vi.fn(async () => ({ success: true })),
  deleteFile: vi.fn(async () => ({ success: true }))
})

const store = (): CheckpointManifestStore => ({
  put: vi.fn(async (_key: string, _value: string | ReadableStream<Uint8Array>) => undefined),
  get: vi.fn(async (_key: string) => archive())
})

const input = (previousCheckpoint: Parameters<typeof createWorkspaceCheckpoint>[2]["previousCheckpoint"]) => ({
  checkpointId: "checkpoint_1",
  subject: "user_1",
  environmentId: "managed_1",
  sessionId: "session_1",
  previousCheckpoint,
  eventCursor: 12,
  nowSeconds: 100,
  retentionSeconds: 7 * 24 * 60 * 60
})

describe("managed workspace checkpoints", () => {
  it("excludes generated dependency trees, builds, caches, and logs", async () => {
    const runtime = sandbox()
    await createWorkspaceCheckpoint(runtime, store(), input(null))
    expect(runtime.exec).toHaveBeenCalledWith(
      expect.stringContaining("--exclude=\"**/node_modules\""),
      expect.any(Object)
    )
    expect(runtime.exec).toHaveBeenCalledWith(
      expect.stringContaining("--exclude-vcs-ignores"),
      expect.any(Object)
    )
    expect(WORKSPACE_BACKUP_EXCLUDES).not.toContain(".git")
  })

  it("skips R2 writes when workspace digest has not changed", async () => {
    const runtime = sandbox()
    const checkpointStore = store()
    const created = await createWorkspaceCheckpoint(runtime, checkpointStore, input(null))
    if (created.status !== "created") throw new Error("Expected checkpoint")
    vi.mocked(runtime.readFile).mockClear()
    vi.mocked(checkpointStore.put).mockClear()
    const skipped = await createWorkspaceCheckpoint(
      runtime,
      checkpointStore,
      input(created.manifest)
    )
    expect(skipped).toMatchObject({
      status: "skipped",
      workspaceDigest: digest,
      manifest: {
        createdAt: created.manifest.createdAt,
        backup: { expiresAt: created.manifest.backup.expiresAt }
      }
    })
    expect(runtime.readFile).not.toHaveBeenCalled()
    expect(checkpointStore.put).not.toHaveBeenCalled()
  })

  it("stores only a secret-free bounded manifest", async () => {
    const runtime = sandbox()
    const values: string[] = []
    const checkpointStore = store()
    vi.mocked(checkpointStore.put).mockImplementation(async (_key, value) => {
      if (typeof value === "string") values.push(value)
    })
    await createWorkspaceCheckpoint(runtime, checkpointStore, input(null))
    const serialized = values[0] ?? ""
    expect(serialized).not.toMatch(/token|credential|secret|prompt/iu)
    expect(serialized).toContain('"workspaceDigest"')
    expect(serialized).toContain('"eventCursor":12')
  })

  it("renews an unchanged archive before its lifecycle expiry", async () => {
    const runtime = sandbox()
    const checkpointStore = store()
    const created = await createWorkspaceCheckpoint(runtime, checkpointStore, input(null))
    if (created.status !== "created") throw new Error("Expected checkpoint")
    vi.mocked(checkpointStore.put).mockClear()

    const renewed = await createWorkspaceCheckpoint(runtime, checkpointStore, {
      ...input(created.manifest),
      nowSeconds: created.manifest.backup.expiresAt - 60
    })

    expect(renewed.status).toBe("created")
    expect(checkpointStore.put).toHaveBeenCalled()
  })

  it("rejects an oversized checkpoint before uploading it", async () => {
    const runtime = sandbox()
    vi.mocked(runtime.exec).mockImplementation(async (command) => ({
      success: true,
      stdout: command.includes("rev-parse")
        ? `${"b".repeat(40)}\nfeature/cloud\n1\n1\n`
        : command.includes("find . -type d")
          ? "2048\n"
          : digest,
      stderr: ""
    }))

    await expect(createWorkspaceCheckpoint(runtime, store(), {
      ...input(null),
      maxBytes: 1024
    })).rejects.toThrow("configured size limit")
    expect(runtime.readFile).not.toHaveBeenCalled()
  })
})
