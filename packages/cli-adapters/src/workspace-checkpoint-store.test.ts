import { execFileSync } from "node:child_process"
import { mkdtemp, writeFile, readFile, rm, chmod, stat, symlink, link, readdir, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WorkspaceCheckpointStore } from "./workspace-checkpoint-store.js"
import { anchoredFs } from "./anchored-fs.js"

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "checkpoint-test-")); roots.push(root)
  git(root, "init", "-q"); git(root, "config", "user.email", "test@example.com"); git(root, "config", "user.name", "Test")
  await writeFile(join(root, "file"), "base"); await writeFile(join(root, ".gitignore"), "secret\n")
  git(root, "add", "."); git(root, "commit", "-qm", "base")
  const storage = join(root, "../", `${root.split("/").pop()}-store`); roots.push(storage)
  return { root, storage, store: new WorkspaceCheckpointStore({ cwd: root, root: storage, sessionId: "test" }) }
}
describe("workspace checkpoint recovery", () => {
  it("restores separate index/worktree bytes, private executable permissions, and preserves ignored/later files", async () => {
    const { root, store } = await fixture()
    await writeFile(join(root, "file"), "staged"); git(root, "add", "file")
    await writeFile(join(root, "file"), "unstaged"); await chmod(join(root, "file"), 0o700)
    await writeFile(join(root, "secret"), "secret")
    const checkpoint = await store.capture()
    await writeFile(join(root, "file"), "later"); git(root, "add", "file")
    await writeFile(join(root, "later"), "retain")
    const preview = await store.preview(checkpoint.id)
    const backup = await store.restore(checkpoint.id, preview.token)
    expect(backup.pinned).toBe(true)
    expect(await readFile(join(root, "file"), "utf8")).toBe("unstaged")
    expect(git(root, "show", ":file")).toBe("staged")
    expect((await stat(join(root, "file"))).mode & 0o777).toBe(0o700)
    expect(await readFile(join(root, "secret"), "utf8")).toBe("secret")
    expect(await readFile(join(root, "later"), "utf8")).toBe("retain")
  })
  it("rejects intent-to-add without changing staging", async () => {
    const { root, store } = await fixture(); await writeFile(join(root, "new"), "new"); git(root, "add", "-N", "new")
    const before = await readFile(join(root, ".git/index"))
    await expect(store.capture()).rejects.toThrow("Intent-to-add")
    expect(await readFile(join(root, ".git/index"))).toEqual(before)
  })
  it("captures A-B-A staging from one immutable index copy", async () => {
    const { root, storage } = await fixture(); const original = await readFile(join(root, ".git/index"))
    const store = new WorkspaceCheckpointStore({ cwd: root, root: storage, sessionId: "test", afterIndexCopy: async () => {
      await writeFile(join(root, "file"), "B"); git(root, "add", "file"); await writeFile(join(root, ".git/index"), original)
    } })
    const checkpoint = await store.capture()
    expect(git(root, "show", `${checkpoint.indexTree}:file`)).toBe("base")
    expect(git(root, "show", `${checkpoint.worktreeTree}:file`)).toBe("B")
  })
  it("permits verified same-HEAD activation and refuses unrelated branches and HEAD drift", async () => {
    const { root, storage, store } = await fixture(); git(root, "checkout", "--detach", "-q")
    const checkpoint = await store.capture(); git(root, "checkout", "-qb", "activated")
    const activated = new WorkspaceCheckpointStore({ cwd: root, root: storage, sessionId: "test", verifiedBranch: "activated" })
    await expect(activated.preview(checkpoint.id)).resolves.toBeDefined()
    await expect(store.preview(checkpoint.id)).rejects.toThrow("HEAD or branch")
    await writeFile(join(root, "file"), "next"); git(root, "commit", "-qam", "next")
    await expect(activated.preview(checkpoint.id)).rejects.toThrow("HEAD or branch")
  })
  it("atomic replacement leaves an external hardlink untouched and refuses storage symlinks", async () => {
    const { root, storage, store } = await fixture(); const sentinel = join(root, "sentinel")
    await writeFile(sentinel, "external"); await link(sentinel, join(root, "linked"))
    await anchoredFs.write(join(root, "linked"), "replacement")
    expect(await readFile(sentinel, "utf8")).toBe("external")
    await symlink(root, storage)
    const mode = (await stat(root)).mode
    await expect(store.capture()).rejects.toThrow()
    expect((await stat(root)).mode).toBe(mode)
    expect(await readFile(sentinel, "utf8")).toBe("external")
  })
  it("refuses stale confirmation and pins recovery before late edits", async () => {
    const { root, storage, store } = await fixture(); const checkpoint = await store.capture()
    await writeFile(join(root, "file"), "later"); const preview = await store.preview(checkpoint.id)
    await writeFile(join(root, "file"), "latest")
    await expect(store.restore(checkpoint.id, preview.token)).rejects.toThrow("stale")
    const fresh = await store.preview(checkpoint.id)
    const racing = new WorkspaceCheckpointStore({ cwd: root, root: storage, sessionId: "test", beforeWrite: async () => { await writeFile(join(root, "file"), "race") } })
    await expect(racing.restore(checkpoint.id, fresh.token)).rejects.toThrow("Safety backup")
    expect(await readFile(join(root, "file"), "utf8")).toBe("race")
    expect((await store.list()).some((item) => item.pinned)).toBe(true)
  })
  it("rejects unsafe index permissions and bounded captures", async () => {
    const { root, store } = await fixture()
    await chmod(join(root, ".git/index"), 0o666)
    await expect(store.capture()).rejects.toThrow("Unsafe checkpoint index")
    await chmod(join(root, ".git/index"), 0o600)
    await writeFile(join(root, "oversized"), Buffer.alloc(32 * 1024 * 1024 + 1))
    await expect(store.capture()).rejects.toThrow("32 MiB")
    expect(await store.list()).toEqual([])
  })
  it("fails closed on corrupt index backups without destroying recovery data", async () => {
    const { root, storage, store } = await fixture(); const checkpoint = await store.capture()
    const owner = (await readdir(storage))[0]!
    const directory = join(storage, owner, checkpoint.id)
    const snapshot = JSON.parse(await readFile(join(directory, "snapshot.json"), "utf8"))
    await writeFile(join(directory, snapshot.indexDigest), "corrupt")
    await expect(store.preview(checkpoint.id)).rejects.toThrow("Corrupt checkpoint index")
    await expect(store.capture()).rejects.toThrow("Corrupt checkpoint index")
    expect(await readFile(join(root, "file"), "utf8")).toBe("base")
    expect(await readFile(join(directory, snapshot.indexDigest), "utf8")).toBe("corrupt")
  })
  it("retains pinned safety backups when retention evicts ordinary captures", async () => {
    const { root, store } = await fixture(); const checkpoint = await store.capture()
    await writeFile(join(root, "file"), "later")
    const backup = await store.restore(checkpoint.id, (await store.preview(checkpoint.id)).token)
    for (let count = 0; count < 20; count++) await store.capture()
    const remaining = await store.list()
    expect(remaining).toHaveLength(20)
    expect(remaining.find((item) => item.id === backup.id)?.pinned).toBe(true)
  }, 30000)

  it("restore atomically breaks a target hardlink without changing its external sentinel", async () => {
    const { root, storage, store } = await fixture(); const checkpoint = await store.capture()
    const sentinel = `${storage}-sentinel`; roots.push(sentinel)
    await writeFile(sentinel, "external")
    await rm(join(root, "file")); await link(sentinel, join(root, "file"))
    await store.restore(checkpoint.id, (await store.preview(checkpoint.id)).token)
    expect(await readFile(join(root, "file"), "utf8")).toBe("base")
    expect(await readFile(sentinel, "utf8")).toBe("external")
  })

  it("recovers a partially completed restore from its pinned backup and leaves a swapped symlink untouched", async () => {
    const { root, storage, store } = await fixture()
    await writeFile(join(root, "second"), "base second"); git(root, "add", "second"); git(root, "commit", "-qm", "second")
    const checkpoint = await store.capture()
    await writeFile(join(root, "file"), "later first"); await writeFile(join(root, "second"), "later second")
    const sentinel = `${storage}-outside`; roots.push(sentinel); await writeFile(sentinel, "external")
    const racing = new WorkspaceCheckpointStore({ cwd: root, root: storage, sessionId: "test", afterFileWrite: async (path) => {
      if (path === "file") { await rm(join(root, "second")); await symlink(sentinel, join(root, "second")) }
    } })
    await expect(racing.restore(checkpoint.id, (await racing.preview(checkpoint.id)).token)).rejects.toThrow("Safety backup")
    expect(await readFile(join(root, "file"), "utf8")).toBe("base")
    expect(await readFile(sentinel, "utf8")).toBe("external")
    const backup = (await store.list()).find((item) => item.pinned)!
    await rm(join(root, "second")); await writeFile(join(root, "second"), "later second")
    await store.restore(backup.id, (await store.preview(backup.id)).token)
    expect(await readFile(join(root, "file"), "utf8")).toBe("later first")
    expect(await readFile(join(root, "second"), "utf8")).toBe("later second")
  })

  it("recovers a real linked worktree and captures every admitted turn without an owner-tool deadlock", async () => {
    const { root, storage } = await fixture(); const linked = `${root}-linked`; roots.push(linked)
    git(root, "worktree", "add", "--detach", linked, "HEAD")
    const store = new WorkspaceCheckpointStore({ cwd: linked, root: storage, sessionId: "linked" })
    await writeFile(join(linked, "file"), "staged linked"); git(linked, "add", "file")
    await writeFile(join(linked, "file"), "unstaged linked")
    const checkpoint = await store.capture()
    await writeFile(join(linked, "file"), "later linked"); git(linked, "add", "file")
    await store.restore(checkpoint.id, (await store.preview(checkpoint.id)).token)
    expect(git(linked, "show", ":file")).toBe("staged linked")
    expect(await readFile(join(linked, "file"), "utf8")).toBe("unstaged linked")
    const { Schema } = await import("effect"); const { Session } = await import("@jingler/core")
    const { acquireCheckpointedTurn } = await import("./workspace-checkpoints.js")
    const { acquireWorkspaceToolActivity, checkpointTurnOwner, resetWorkspaceAdmissions } = await import("./workspace-admission.js")
    const session = Schema.decodeUnknownSync(Session)({ id: "linked", repo: "test", branch: "main", title: "test", status: "idle", diff: { added: 0, removed: 0 }, prNumber: null, costUsd: 0, tokens: 0, updatedAt: "now", chats: [], activeChatId: "chat", workspaceMode: "worktree", worktreePath: linked, checkpointExecutionHistory: "clean", checkpointSafeMode: true })
    try {
      for (let count = 0; count < 2; count++) {
        const turn = await acquireCheckpointedTurn(session, storage)
        const tool = acquireWorkspaceToolActivity("linked", checkpointTurnOwner("linked")); tool.release(); turn.release()
      }
      expect((await store.list()).filter((item) => item.label.startsWith("Before agent turn"))).toHaveLength(2)
    } finally { resetWorkspaceAdmissions() }
  }, 10000)

})

it("retains the oldest restore source when all twenty slots are full", async () => {
  const { root, store } = await fixture()
  const oldest = await store.capture("oldest")
  for (let i = 0; i < 19; i++) await store.capture(`later ${i}`)
  await writeFile(join(root, "file"), "edited")
  const preview = await store.preview(oldest.id)
  const backup = await store.restore(oldest.id, preview.token)
  expect(await readFile(join(root, "file"), "utf8")).toBe("base")
  expect((await store.list()).map(item => item.id)).toContain(oldest.id)
  expect(backup.pinned).toBe(true)
  expect((await store.list()).length).toBe(20)
})
it.each(["overwrite", "delete", "create"] as const)("refuses late external %s changes inside the anchored worker", async action => {
  const { root, store } = await fixture()
  if (action === "delete") { await writeFile(join(root, "file"), "base"); git(root, "rm", "file") }
  const checkpoint = await store.capture()
  if (action === "delete") { await writeFile(join(root, "file"), "current"); git(root, "add", "file") }
  else if (action === "create") { await rm(join(root, "file")); git(root, "add", "file") }
  else await writeFile(join(root, "file"), "current")
  const preview = await store.preview(checkpoint.id)
  const target = join(root, "file")
  const originalWrite = anchoredFs.write
  const originalUnlink = anchoredFs.unlink
  vi.spyOn(anchoredFs, "write").mockImplementation(async (path, ...args) => {
    if (path === target) await writeFile(target, "late external bytes")
    return originalWrite(path, ...args)
  })
  vi.spyOn(anchoredFs, "unlink").mockImplementation(async (path, ...args) => {
    if (path === target) await writeFile(target, "late external bytes")
    return originalUnlink(path, ...args)
  })
  await expect(store.restore(checkpoint.id, preview.token)).rejects.toThrow("backup")
  expect(await readFile(target, "utf8")).toBe("late external bytes")
  expect((await store.list()).some(item => item.pinned)).toBe(true)
})

it.each([10, 40])("measures Git subprocesses for a %i-file capture", async count => {
  const { root, store } = await fixture()
  for (let i = 0; i < count; i++) await writeFile(join(root, `batch-${i}`), `bytes-${i}`)
  git(root, "add", ".")
  const calls = vi.spyOn(anchoredFs, "git")
  const started = performance.now()
  await store.capture()
  console.log(`capture measurement: added=${count}, Git subprocesses=${calls.mock.calls.length}, elapsedMs=${Math.round(performance.now() - started)}`)
  expect(calls.mock.calls.length).toBe(24)
  for (const operation of ["check-ignore", "cat-file", "hash-object"]) expect(calls.mock.calls.filter(([, args]) => args[0] === operation)).toHaveLength(1)
}, 30000)


it.each(["overwrite", "create", "mode"])("previews and restores staged-only %s without claiming file changes", async action => {
  const { root, store } = await fixture(); const checkpoint = await store.capture()
  if (action === "overwrite") { await writeFile(join(root, "file"), "staged only"); git(root, "add", "file"); await writeFile(join(root, "file"), "base") }
  if (action === "create") { await writeFile(join(root, "new"), "staged new"); git(root, "add", "new"); await rm(join(root, "new")) }
  if (action === "mode") git(root, "update-index", "--chmod=+x", "file")
  const preview = await store.preview(checkpoint.id)
  expect(preview.operations).toEqual([]); expect(preview.diff).toBe("")
  expect(preview.indexOperations).toEqual([{ path: action === "create" ? "new" : "file", action: action === "create" ? "delete" : "overwrite" }])
  expect(preview.indexDiff).toContain(action === "create" ? "new" : "file")
  await store.restore(checkpoint.id, preview.token)
  expect(git(root, "write-tree")).toBe(checkpoint.indexTree)
})
it("retains failed and latest successful backups durably across more than twenty restores", async () => {
  const { root, storage, store } = await fixture(); const checkpoint = await store.capture()
  const failed = new WorkspaceCheckpointStore({ cwd: root, root: storage, sessionId: "test", beforeWrite: async () => { throw new Error("injected failure") } })
  await expect(failed.restore(checkpoint.id, (await failed.preview(checkpoint.id)).token)).rejects.toThrow("injected failure")
  const failedBackup = (await store.list()).find(item => item.restoreOutcome === "failed")!
  expect(failedBackup.pinned).toBe(true)
  let latest = ""
  for (let i = 0; i < 23; i++) {
    await writeFile(join(root, "file"), `edit ${i}`)
    latest = (await store.restore(checkpoint.id, (await store.preview(checkpoint.id)).token)).id
  }
  const reopened = new WorkspaceCheckpointStore({ cwd: root, root: storage, sessionId: "test" })
  const items = await reopened.list()
  expect(items).toHaveLength(20)
  expect(items.filter(item => item.pinned).map(item => item.id).sort()).toEqual([failedBackup.id, latest].sort())
  expect(items.find(item => item.id === latest)?.restoreOutcome).toBe("succeeded")
  expect(items.find(item => item.id === failedBackup.id)?.restoreOutcome).toBe("failed")
  expect(items.find(item => item.id === checkpoint.id)).toBeDefined()
}, 60000)
it("captures a deleted tracked directory and restores its contents", async () => {
  const { root, store } = await fixture()
  await mkdir(join(root, "tracked/nested"), { recursive: true })
  await writeFile(join(root, "tracked/nested/file"), "tracked bytes"); git(root, "add", "tracked")
  const before = await store.capture()
  await rm(join(root, "tracked"), { recursive: true })
  const deleted = await store.capture()
  expect(git(root, "ls-tree", "-r", "--name-only", deleted.worktreeTree)).not.toContain("tracked/nested/file")
  expect(git(root, "show", `${deleted.indexTree}:tracked/nested/file`)).toBe("tracked bytes")
  await store.restore(before.id, (await store.preview(before.id)).token)
  expect(await readFile(join(root, "tracked/nested/file"), "utf8")).toBe("tracked bytes")
})
it("batches binary/newline path bytes without filters or hooks and preserves private modes", async () => {
  const { root, store } = await fixture(); const path = "space tab\tnewline\nfile"
  const raw = Buffer.from([0, 255, 13, 10, 36, 0, 9])
  await writeFile(join(root, path), raw); await chmod(join(root, path), 0o700)
  await writeFile(join(root, ".gitattributes"), "* text eol=lf\n")
  git(root, "add", ".")
  const checkpoint = await store.capture()
  expect(execFileSync("git", ["show", `${checkpoint.worktreeTree}:${path}`], { cwd: root })).toEqual(raw)
  await writeFile(join(root, path), "later"); await chmod(join(root, path), 0o600)
  await store.restore(checkpoint.id, (await store.preview(checkpoint.id)).token)
  expect(await readFile(join(root, path))).toEqual(raw)
  expect((await stat(join(root, path))).mode & 0o777).toBe(0o700)
  await writeFile(join(root, ".gitattributes"), "* filter=unsafe\n")
  git(root, "config", "filter.unsafe.clean", "touch filter-sentinel; cat")
  await expect(store.capture()).rejects.toThrow("unsupported Git filter")
  await expect(stat(join(root, "filter-sentinel"))).rejects.toMatchObject({ code: "ENOENT" })
})
it("rejects a malformed size-delimited staged blob batch", async () => {
  const { store } = await fixture(); const original = anchoredFs.git
  vi.spyOn(anchoredFs, "git").mockImplementation(async (cwd, args, ...rest) => args[0] === "cat-file" ? Buffer.from("0".repeat(40) + " blob 999999999999999999999\n") : original(cwd, args, ...rest))
  await expect(store.capture()).rejects.toThrow("Invalid or oversized checkpoint blob batch")
  expect(await store.list()).toEqual([])
})

it("restores staged deletion with an absent worktree target", async () => {
  const { root, store } = await fixture(); const checkpoint = await store.capture()
  git(root, "rm", "file")
  const preview = await store.preview(checkpoint.id)
  expect(preview.operations).toEqual([{ path: "file", action: "create" }])
  expect(preview.indexOperations).toEqual([{ path: "file", action: "create" }])
  expect(preview.indexDiff).toContain("file")
  await store.restore(checkpoint.id, preview.token)
  expect(git(root, "write-tree")).toBe(checkpoint.indexTree)
  expect(await readFile(join(root, "file"), "utf8")).toBe("base")
})
it("refuses later untracked collisions even when bytes match the checkpoint", async () => {
  const { root, store } = await fixture(); const checkpoint = await store.capture()
  git(root, "rm", "--cached", "file")
  await expect(store.preview(checkpoint.id)).rejects.toThrow("untracked collision")
  expect(await readFile(join(root, "file"), "utf8")).toBe("base")
  expect(git(root, "ls-files", "file")).toBe("")
})
