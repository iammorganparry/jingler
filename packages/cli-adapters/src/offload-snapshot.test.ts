import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import { Cause, Effect, Exit, Option } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import {
  captureOffloadSnapshot,
  OffloadSnapshotService
} from "./offload-snapshot.js"

const roots: string[] = []

const repository = () => {
  const root = mkdtempSync(join(tmpdir(), "jingler-offload-snapshot-"))
  roots.push(root)
  execFileSync("git", ["init", "--initial-branch=main", "--quiet"], { cwd: root })
  execFileSync("git", ["config", "user.email", "test@jingler.dev"], { cwd: root })
  execFileSync("git", ["config", "user.name", "Jingler Test"], { cwd: root })
  writeFileSync(join(root, "staged.txt"), "base staged\n")
  writeFileSync(join(root, "unstaged.txt"), "base unstaged\n")
  execFileSync("git", ["add", "."], { cwd: root })
  execFileSync("git", ["commit", "--quiet", "-m", "base"], { cwd: root })
  return root
}

const payloadOf = (compressedBytes: Uint8Array) =>
  JSON.parse(gunzipSync(compressedBytes).toString("utf8")) as {
    headSha: string
    headArchiveBase64: string
    headArchiveBytes: number
    headArchiveDigest: string
    stagedPatch: string
    unstagedPatch: string
  }

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("OffloadSnapshotService capture", () => {
  it("captures a self-contained deterministic HEAD plus staged and unstaged state", async () => {
    const root = repository()
    writeFileSync(join(root, "staged.txt"), "staged change\n")
    execFileSync("git", ["add", "staged.txt"], { cwd: root })
    writeFileSync(join(root, "unstaged.txt"), "unstaged change\n")
    writeFileSync(join(root, "new.txt"), "untracked\n")

    const first = await Effect.runPromise(captureOffloadSnapshot(root))
    const second = await Effect.runPromise(captureOffloadSnapshot(root))
    const payload = payloadOf(first.compressedBytes)

    expect(first.identity).toEqual(second.identity)
    expect(payload.stagedPatch).toContain("staged change")
    expect(payload.unstagedPatch).toContain("unstaged change")
    expect(payload.headArchiveBytes).toBeGreaterThan(0)
    expect(Buffer.from(payload.headArchiveBase64, "base64")).toHaveLength(
      payload.headArchiveBytes
    )
    expect(gunzipSync(first.compressedBytes).toString()).not.toContain("untracked")
  })

  it("detects a worktree mutation during capture", async () => {
    const root = repository()
    writeFileSync(join(root, "unstaged.txt"), "first change\n")
    const exit = await Effect.runPromiseExit(
      captureOffloadSnapshot(root, {
        afterInitialCapture: () =>
          Effect.sync(() => writeFileSync(join(root, "unstaged.txt"), "second change\n"))
      })
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const cause = Option.getOrThrow(Cause.failureOption(exit.cause))
      expect(cause.reason).toBe("moving-worktree")
    }
  })

})

describe("Offload snapshot safeguards", () => {
  it("excludes ignored and untracked files unless the operator stages them", async () => {
    const root = repository()
    writeFileSync(join(root, "arbitrary-private-fixture.json"), "super-secret-local-value\n")
    writeFileSync(join(root, ".gitignore"), "ignored-private.txt\n")
    writeFileSync(join(root, "ignored-private.txt"), "ignored-secret\n")
    const snapshot = await Effect.runPromise(captureOffloadSnapshot(root))
    const payload = gunzipSync(snapshot.compressedBytes).toString("utf8")
    expect(payload).not.toContain("super-secret-local-value")
    expect(payload).not.toContain("ignored-secret")
  })

  it.each([
    ["secret-prone", ".env", "secret-path"],
    ["excluded", "node_modules/leak.txt", "unsafe-path"]
  ])("rejects %s explicitly staged paths", async (_label, path, reason) => {
    const root = repository()
    const absolute = join(root, path)
    if (path.includes("/")) {
      execFileSync("mkdir", ["-p", join(root, path.split("/")[0]!)])
    }
    writeFileSync(absolute, "not-a-real-secret\n")
    execFileSync("git", ["add", "--force", path], { cwd: root })
    const exit = await Effect.runPromiseExit(captureOffloadSnapshot(root))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Option.getOrThrow(Cause.failureOption(exit.cause)).reason).toBe(reason)
    }
  })

  it("rejects symlinks and snapshots over the configured bound", async () => {
    const root = repository()
    symlinkSync("staged.txt", join(root, "linked.txt"))
    execFileSync("git", ["add", "linked.txt"], { cwd: root })
    const linked = await Effect.runPromiseExit(captureOffloadSnapshot(root))
    expect(Exit.isFailure(linked)).toBe(true)

    execFileSync("git", ["reset", "--hard", "--quiet"], { cwd: root })
    writeFileSync(join(root, "large.txt"), "x".repeat(512))
    execFileSync("git", ["add", "large.txt"], { cwd: root })
    const large = await Effect.runPromiseExit(
      captureOffloadSnapshot(root, { maxBytes: 128 })
    )
    expect(Exit.isFailure(large)).toBe(true)
    if (Exit.isFailure(large)) {
      expect(Option.getOrThrow(Cause.failureOption(large.cause)).reason).toBe("too-large")
    }
  })
})

describe("OffloadSnapshotService upload", () => {
  it("uploads the compressed digest with interruption-aware fetch", async () => {
    const root = repository()
    writeFileSync(join(root, "new.txt"), "upload me\n")
    const snapshot = await Effect.runPromise(captureOffloadSnapshot(root))
    const requests: Array<{ authorization: string | undefined; digest: string | undefined }> = []
    const server = createServer((request, response) => {
      requests.push({
        authorization: request.headers.authorization,
        digest: request.headers["x-jingler-snapshot-digest"] as string | undefined
      })
      request.resume()
      request.on("end", () => {
        response.statusCode = 204
        response.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("Missing test address")
    const progress: number[] = []
    try {
      const uploaded = await Effect.runPromise(
        OffloadSnapshotService.upload({
          url: `http://127.0.0.1:${address.port}/snapshot`,
          grant: "grant_aaaaaaaaaaaaaaaa",
          snapshot,
          onProgress: (completed) => progress.push(completed)
        }).pipe(Effect.provide(OffloadSnapshotService.Default))
      )
      expect(uploaded.digest).toBe(snapshot.identity.digest)
      expect(requests).toEqual([
        {
          authorization: "Bearer grant_aaaaaaaaaaaaaaaa",
          digest: snapshot.identity.digest
        }
      ])
      expect(progress).toEqual([0, snapshot.compressedBytes.byteLength])
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((cause) => cause ? reject(cause) : resolve())
      )
    }
  })
})
