import { execFileSync } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureOffloadSnapshot } from "@jingler/cli-adapters/offload-snapshot"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { makeOwnedDeviceOffloadExecutor } from "./offload-device.js"

let root: string
let repository: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jingler-owned-offload-"))
  repository = join(root, "source")
  execFileSync("mkdir", ["-p", repository])
  execFileSync("git", ["init", "--quiet"], { cwd: repository })
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repository })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repository })
  await writeFile(join(repository, "source.txt"), "unchanged\n")
  execFileSync("git", ["add", "."], { cwd: repository })
  execFileSync("git", ["commit", "--quiet", "-m", "base"], { cwd: repository })
})

afterEach(() => {
  execFileSync("rm", ["-rf", root])
})

describe("owned-device offload executor", () => {
  it("reassembles a bounded snapshot and runs literal argv in an isolated workspace", async () => {
    const snapshot = await Effect.runPromise(captureOffloadSnapshot(repository))
    const executor = makeOwnedDeviceOffloadExecutor(root)
    const jobId = "job_abcdefghijklmnop"
    await executor.begin({
      jobId,
      snapshotDigest: snapshot.identity.digest,
      snapshotBytes: snapshot.uncompressedBytes,
      compressedBytes: snapshot.compressedBytes.byteLength,
      chunkCount: 1,
      command: {
        source: { kind: "preset", preset: "test" },
        executable: "node",
        args: ["-e", "process.stdout.write(require('fs').readFileSync('source.txt','utf8'))"],
        cwd: "."
      },
      limits: {
        timeoutSeconds: 30,
        snapshotBytes: snapshot.uncompressedBytes,
        outputBytes: 1024
      }
    })
    await executor.chunk({
      jobId,
      index: 0,
      contentBase64: Buffer.from(snapshot.compressedBytes).toString("base64")
    })

    const result = await executor.execute({ jobId })

    expect(result).toMatchObject({ exitCode: 0, stdout: "unchanged\n", sourceMutated: false })
    expect(await executor.execute({ jobId })).toEqual(result)
  })

  it("reports source mutation without changing the originating repository", async () => {
    const snapshot = await Effect.runPromise(captureOffloadSnapshot(repository))
    const executor = makeOwnedDeviceOffloadExecutor(root)
    const jobId = "job_bcdefghijklmnopq"
    await executor.begin({
      jobId,
      snapshotDigest: snapshot.identity.digest,
      snapshotBytes: snapshot.uncompressedBytes,
      compressedBytes: snapshot.compressedBytes.byteLength,
      chunkCount: 1,
      command: {
        source: { kind: "explicit", commandId: "mutation-probe" },
        executable: "node",
        args: ["-e", "require('fs').writeFileSync('source.txt','changed')"],
        cwd: "."
      },
      limits: { timeoutSeconds: 30, snapshotBytes: snapshot.uncompressedBytes, outputBytes: 1024 }
    })
    await executor.chunk({
      jobId,
      index: 0,
      contentBase64: Buffer.from(snapshot.compressedBytes).toString("base64")
    })

    expect((await executor.execute({ jobId })).sourceMutated).toBe(true)
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repository, encoding: "utf8" })).toBe("")
  })
})
