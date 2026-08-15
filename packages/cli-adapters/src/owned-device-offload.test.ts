import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import { makeOwnedDeviceOffloadPort } from "./owned-device-offload.js"
import type { ToolExecutionContext } from "./runtime/tools/tool-registry.js"

const context = (): ToolExecutionContext => ({
  signal: new AbortController().signal,
  idempotencyKey: "owned-device-call",
  progress: () => undefined
})

describe("owned-device offload transport", () => {
  it("chunks snapshots through the selected environment and returns output", async () => {
    const operations: string[] = []
    const remote = {
      requestOnEnvironment: (environmentId: string, operation: string) => {
        expect(environmentId).toBe("device_selected")
        operations.push(operation)
        return Effect.succeed(operation === "Offload.execute" ? {
          exitCode: 0,
          stdout: "verified",
          stderr: "",
          outputTruncated: false,
          timedOut: false,
          sourceMutated: false,
          commandMs: 10
        } : undefined)
      }
    }
    const port = makeOwnedDeviceOffloadPort(remote, () => Effect.succeed(true))
    const result = await Effect.runPromise(port.execute({
      deviceId: "device_selected",
      jobId: "job_abcdefghijklmnop",
      snapshot: {
        identity: { version: 1, headSha: "a".repeat(40), digest: "b".repeat(64), bytes: 700_000 },
        compressedBytes: new Uint8Array(700_000),
        fileCount: 1,
        uncompressedBytes: 700_000
      },
      command: {
        source: { kind: "preset", preset: "typecheck" },
        executable: "pnpm",
        args: ["typecheck"],
        cwd: "."
      },
      limits: { timeoutSeconds: 60, snapshotBytes: 700_000, outputBytes: 1024 },
      context: context()
    }))

    expect(operations).toEqual(["Offload.begin", "Offload.chunk", "Offload.chunk", "Offload.execute"])
    expect(result).toMatchObject({ stdout: "verified", offloaded: true })
  })

  it("rejects an offline selected device before opening a request tunnel", async () => {
    const requestOnEnvironment = vi.fn(() => Effect.succeed(undefined))
    const port = makeOwnedDeviceOffloadPort(
      { requestOnEnvironment },
      () => Effect.succeed(false)
    )

    await expect(Effect.runPromise(port.execute({
      deviceId: "device_offline",
      jobId: "job_cdefghijklmnopqr",
      snapshot: {
        identity: { version: 1, headSha: "a".repeat(40), digest: "b".repeat(64), bytes: 1 },
        compressedBytes: new Uint8Array([1]),
        fileCount: 1,
        uncompressedBytes: 1
      },
      command: {
        source: { kind: "preset", preset: "test" },
        executable: "npm",
        args: ["test"],
        cwd: "."
      },
      limits: { timeoutSeconds: 60, snapshotBytes: 1, outputBytes: 1024 },
      context: context()
    }))).rejects.toThrow("did not fall back")
    expect(requestOnEnvironment).not.toHaveBeenCalled()
  })

  it("rejects a source-mutating result instead of syncing it locally", async () => {
    const remote = {
      requestOnEnvironment: vi.fn((_environmentId: string, operation: string) =>
        Effect.succeed(operation === "Offload.execute" ? {
          exitCode: 0,
          stdout: "",
          stderr: "",
          outputTruncated: false,
          timedOut: false,
          sourceMutated: true,
          commandMs: 1
        } : undefined))
    }
    const port = makeOwnedDeviceOffloadPort(remote, () => Effect.succeed(true))
    await expect(Effect.runPromise(port.execute({
      deviceId: "device_selected",
      jobId: "job_bcdefghijklmnopq",
      snapshot: {
        identity: { version: 1, headSha: "a".repeat(40), digest: "b".repeat(64), bytes: 1 },
        compressedBytes: new Uint8Array([1]),
        fileCount: 1,
        uncompressedBytes: 1
      },
      command: {
        source: { kind: "preset", preset: "test" },
        executable: "npm",
        args: ["test"],
        cwd: "."
      },
      limits: { timeoutSeconds: 60, snapshotBytes: 1, outputBytes: 1024 },
      context: context()
    }))).rejects.toThrow("nothing was synced locally")
  })
})
