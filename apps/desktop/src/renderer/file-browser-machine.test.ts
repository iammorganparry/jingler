// @vitest-environment node
import type { AssetPayload } from "@jingler/core"
import { createActor, type ActorRefFrom } from "xstate"
import { describe, expect, it, vi } from "vitest"
import {
  createFileBrowserMachine,
  type FileBrowserApi,
  type FileBrowserMachine
} from "./file-browser-machine.js"

const payload = (
  text: string,
  revision: string
): Extract<AssetPayload, { readonly text: string }> => ({
  path: "src/app.ts",
  absolutePath: "/worktree/src/app.ts",
  size: text.length,
  kind: "code",
  language: "typescript",
  text,
  revision
})

const markdownPayload = (text: string, revision: string): AssetPayload => ({
  path: "docs/spec.md",
  absolutePath: "/worktree/docs/spec.md",
  size: text.length,
  kind: "markdown",
  language: "markdown",
  text,
  revision
})

const waitFor = (
  actor: ActorRefFrom<FileBrowserMachine>,
  predicate: (snapshot: ReturnType<typeof actor.getSnapshot>) => boolean
): Promise<void> =>
  new Promise((resolve, reject) => {
    if (predicate(actor.getSnapshot())) return resolve()
    const interval = setInterval(() => {
      if (!predicate(actor.getSnapshot())) return
      clearInterval(interval)
      clearTimeout(timeout)
      resolve()
    }, 5)
    const timeout = setTimeout(() => {
      clearInterval(interval)
      reject(
        new Error(
          `Timed out waiting for file browser state: ${JSON.stringify(actor.getSnapshot().value)}`
        )
      )
    }, 2_000)
  })

const start = (overrides: Partial<FileBrowserApi> = {}) => {
  const api: FileBrowserApi = {
    list: vi.fn().mockResolvedValue([{ path: "src/app.ts", status: "clean" }]),
    diff: vi.fn().mockResolvedValue(""),
    read: vi.fn().mockResolvedValue(payload("before", "sha256:before")),
    write: vi.fn().mockResolvedValue(payload("after", "sha256:after")),
    ...overrides
  }
  const actor = createActor(createFileBrowserMachine(api), {
    input: { sessionId: "session-a" }
  }).start()
  return { actor, api }
}

describe("fileBrowserMachine", () => {
  it("loads the repository tree independently from document selection", async () => {
    const { actor } = start()
    expect(actor.getSnapshot().matches({ tree: "loading" })).toBe(true)
    expect(actor.getSnapshot().matches({ document: "idle" })).toBe(true)

    await waitFor(actor, (snapshot) => snapshot.matches({ tree: "ready" }))
    expect(actor.getSnapshot().context.entries).toEqual([{ path: "src/app.ts", status: "clean" }])
  })

  it("adds a successfully opened agent-created path to a stale initial tree", async () => {
    const created = {
      ...markdownPayload("# Created", "sha256:created"),
      path: "reports/created.md"
    }
    const { actor } = start({ read: vi.fn().mockResolvedValue(created) })
    await waitFor(actor, (snapshot) => snapshot.matches({ tree: "ready" }))

    actor.send({ type: "OPEN", path: "reports/created.md" })
    await waitFor(actor, (snapshot) => snapshot.matches({ document: { ready: "clean" } }))

    expect(actor.getSnapshot().context.entries).toEqual([
      { path: "reports/created.md", status: "untracked" },
      { path: "src/app.ts", status: "clean" }
    ])
  })

  it("loads, edits, and saves with the loaded revision", async () => {
    const write = vi.fn().mockResolvedValue(payload("changed", "sha256:changed"))
    const { actor } = start({ write })
    actor.send({ type: "OPEN", path: "src/app.ts" })
    await waitFor(actor, (snapshot) => snapshot.matches({ document: { ready: "clean" } }))

    actor.send({ type: "EDIT", text: "changed" })
    expect(actor.getSnapshot().matches({ document: { ready: "dirty" } })).toBe(true)
    actor.send({ type: "SAVE" })
    expect(actor.getSnapshot().matches({ document: "saving" })).toBe(true)
    await waitFor(actor, (snapshot) => snapshot.matches({ document: { ready: "saved" } }))

    expect(write).toHaveBeenCalledWith("session-a", "src/app.ts", "changed", "sha256:before")
    expect(actor.getSnapshot().context.payload).toEqual(payload("changed", "sha256:changed"))
  })

  it("keeps unchanged edits clean before and after a save", async () => {
    const { actor } = start()
    actor.send({ type: "OPEN", path: "src/app.ts" })
    await waitFor(actor, (snapshot) => snapshot.matches({ document: { ready: "clean" } }))

    actor.send({ type: "EDIT", text: "before" })
    expect(actor.getSnapshot().matches({ document: { ready: "clean" } })).toBe(true)

    actor.send({ type: "EDIT", text: "after" })
    actor.send({ type: "SAVE" })
    await waitFor(actor, (snapshot) => snapshot.matches({ document: { ready: "saved" } }))
    actor.send({ type: "EDIT", text: "after" })
    expect(actor.getSnapshot().matches({ document: { ready: "saved" } })).toBe(true)
  })

  it("refreshes a stale revision without discarding the retained draft", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(payload("before", "sha256:before"))
      .mockResolvedValueOnce(payload("agent edit", "sha256:agent"))
    const write = vi.fn().mockRejectedValue({
      _tag: "AssetWriteConflictError",
      path: "src/app.ts",
      expectedRevision: "sha256:before",
      actualRevision: "sha256:agent"
    })
    const { actor } = start({ read, write })
    actor.send({ type: "OPEN", path: "src/app.ts" })
    await waitFor(actor, (snapshot) => snapshot.matches({ document: { ready: "clean" } }))
    actor.send({ type: "EDIT", text: "my draft" })
    actor.send({ type: "SAVE" })
    await waitFor(actor, (snapshot) => snapshot.matches({ document: "conflict" }))

    expect(actor.getSnapshot().context.draft).toBe("my draft")
    expect(actor.getSnapshot().context.failure?.type).toBe("conflict")

    actor.send({ type: "EDIT", text: "my revised draft" })
    expect(actor.getSnapshot().context.failure?.type).toBe("conflict")
    actor.send({ type: "REFRESH_CONFLICT" })
    await waitFor(actor, (snapshot) => snapshot.matches({ document: { ready: "dirty" } }))
    expect(actor.getSnapshot().context.draft).toBe("my revised draft")
    expect(actor.getSnapshot().context.payload).toEqual(payload("agent edit", "sha256:agent"))
    expect(actor.getSnapshot().context.failure).toBeNull()
  })

  it("surfaces binary reads without manufacturing an editable payload", async () => {
    const { actor } = start({
      read: vi.fn().mockRejectedValue({
        _tag: "AssetBinaryError",
        path: "vendor/blob"
      })
    })
    actor.send({ type: "OPEN", path: "vendor/blob" })
    await waitFor(actor, (snapshot) => snapshot.matches({ document: "binary" }))
    expect(actor.getSnapshot().context.failure).toEqual({
      type: "binary",
      path: "vendor/blob"
    })
    expect(actor.getSnapshot().context.draft).toBeNull()
  })

  it("keeps edits made during an in-flight save dirty after the first write completes", async () => {
    let finishWrite: ((result: ReturnType<typeof payload>) => void) | undefined
    const write = vi.fn(
      () =>
        new Promise<ReturnType<typeof payload>>((resolve) => {
          finishWrite = resolve
        })
    )
    const { actor } = start({ write })
    actor.send({ type: "OPEN", path: "src/app.ts" })
    await waitFor(actor, (snapshot) => snapshot.matches({ document: { ready: "clean" } }))

    actor.send({ type: "EDIT", text: "first edit" })
    actor.send({ type: "SAVE" })
    actor.send({ type: "EDIT", text: "second edit" })
    finishWrite?.(payload("first edit", "sha256:first"))

    await waitFor(actor, (snapshot) => snapshot.matches({ document: { ready: "dirty" } }))
    expect(actor.getSnapshot().context.payload).toEqual(payload("first edit", "sha256:first"))
    expect(actor.getSnapshot().context.draft).toBe("second edit")
  })

  it("retries a failed save without discarding the draft", async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk busy"))
      .mockResolvedValueOnce(payload("my draft", "sha256:retry"))
    const { actor } = start({ write })
    actor.send({ type: "OPEN", path: "src/app.ts" })
    await waitFor(actor, (snapshot) => snapshot.matches({ document: { ready: "clean" } }))
    actor.send({ type: "EDIT", text: "my draft" })
    actor.send({ type: "SAVE" })
    await waitFor(actor, (snapshot) => snapshot.matches({ document: "saveError" }))

    expect(actor.getSnapshot().context.draft).toBe("my draft")
    actor.send({ type: "SAVE" })
    await waitFor(actor, (snapshot) => snapshot.matches({ document: { ready: "saved" } }))
    expect(write).toHaveBeenCalledTimes(2)
    expect(actor.getSnapshot().context.draft).toBe("my draft")
  })

  it("surfaces post-containment write failures as retryable I/O errors", async () => {
    const write = vi.fn().mockRejectedValue({
      _tag: "AssetWriteIoError",
      path: "src/app.ts",
      message: "Could not safely replace the file."
    })
    const { actor } = start({ write })
    actor.send({ type: "OPEN", path: "src/app.ts" })
    await waitFor(actor, (snapshot) => snapshot.matches({ document: { ready: "clean" } }))
    actor.send({ type: "EDIT", text: "my draft" })
    actor.send({ type: "SAVE" })
    await waitFor(actor, (snapshot) => snapshot.matches({ document: "saveError" }))

    expect(actor.getSnapshot().context.failure).toEqual({
      type: "error",
      message: "Could not safely replace the file."
    })
    expect(actor.getSnapshot().context.draft).toBe("my draft")
  })

  it("guards dirty file switches and reloads until discard is confirmed", async () => {
    const read = vi.fn((_: string, path: string) =>
      Promise.resolve(
        path === "src/other.ts"
          ? { ...payload("other", "sha256:other"), path: "src/other.ts" }
          : payload("disk version", "sha256:disk")
      )
    )
    const { actor } = start({ read })
    actor.send({ type: "OPEN", path: "src/app.ts" })
    await waitFor(actor, (snapshot) => snapshot.matches({ document: { ready: "clean" } }))
    actor.send({ type: "EDIT", text: "my draft" })

    actor.send({ type: "OPEN", path: "src/other.ts" })
    expect(actor.getSnapshot().context.selectedPath).toBe("src/app.ts")
    expect(actor.getSnapshot().context.draft).toBe("my draft")
    expect(actor.getSnapshot().context.pendingDiscard).toEqual({
      type: "open",
      path: "src/other.ts"
    })
    actor.send({ type: "CANCEL_DISCARD" })
    expect(actor.getSnapshot().context.pendingDiscard).toBeNull()

    actor.send({ type: "RELOAD" })
    expect(actor.getSnapshot().context.pendingDiscard).toEqual({
      type: "reload"
    })
    actor.send({ type: "CONFIRM_DISCARD" })
    await waitFor(actor, (snapshot) => snapshot.matches({ document: { ready: "clean" } }))
    expect(actor.getSnapshot().context.selectedPath).toBe("src/app.ts")
    expect(actor.getSnapshot().context.draft).toBe("disk version")
  })

  it("opens each repository path once and focuses an existing file tab", async () => {
    const read = vi.fn((_: string, path: string) =>
      Promise.resolve({
        ...payload(path, `sha256:${path}`),
        path,
        absolutePath: `/worktree/${path}`
      })
    )
    const { actor } = start({ read })

    actor.send({ type: "OPEN", path: "src/app.ts" })
    await waitFor(actor, (snapshot) => snapshot.context.selectedPath === "src/app.ts")
    actor.send({ type: "OPEN", path: "src/other.ts" })
    await waitFor(actor, (snapshot) => snapshot.context.selectedPath === "src/other.ts")
    actor.send({ type: "OPEN", path: "src/app.ts" })
    await waitFor(actor, (snapshot) =>
      snapshot.matches({ document: { ready: "clean" } }) &&
      snapshot.context.selectedPath === "src/app.ts"
    )

    expect(actor.getSnapshot().context.openPaths).toEqual(["src/app.ts", "src/other.ts"])
  })

  it("focuses the active dirty file tab without asking to discard its draft", async () => {
    const { actor } = start()
    actor.send({ type: "OPEN", path: "src/app.ts" })
    await waitFor(actor, (snapshot) => snapshot.matches({ document: { ready: "clean" } }))

    actor.send({ type: "EDIT", text: "export const changed = true\n" })
    actor.send({ type: "OPEN", path: "src/app.ts" })

    expect(actor.getSnapshot().context.pendingDiscard).toBeNull()
    expect(actor.getSnapshot().context.draft).toBe("export const changed = true\n")
    expect(actor.getSnapshot().context.openPaths).toEqual(["src/app.ts"])
  })

  it("keeps repository entries intact while opening switching and closing files", async () => {
    const entries = [
      { path: "src/app.ts", status: "clean" as const },
      { path: "src/other.ts", status: "modified" as const }
    ]
    const read = vi.fn((_: string, path: string) =>
      Promise.resolve({ ...payload(path, `sha256:${path}`), path })
    )
    const { actor } = start({ list: vi.fn().mockResolvedValue(entries), read })
    await waitFor(actor, (snapshot) => snapshot.matches({ tree: "ready" }))

    actor.send({ type: "OPEN", path: "src/app.ts" })
    await waitFor(actor, (snapshot) => snapshot.matches({ document: { ready: "clean" } }))
    actor.send({ type: "OPEN", path: "src/other.ts" })
    await waitFor(actor, (snapshot) => snapshot.context.selectedPath === "src/other.ts")
    actor.send({ type: "CLOSE", path: "src/app.ts" })

    expect(actor.getSnapshot().context.entries).toEqual(entries)
    expect(actor.getSnapshot().context.openPaths).toEqual(["src/other.ts"])
  })

  it("closes a clean file tab and selects the adjacent open file", async () => {
    const read = vi.fn((_: string, path: string) =>
      Promise.resolve({ ...payload(path, `sha256:${path}`), path })
    )
    const { actor } = start({ read })
    actor.send({ type: "OPEN", path: "src/app.ts" })
    await waitFor(actor, (snapshot) => snapshot.matches({ document: { ready: "clean" } }))
    actor.send({ type: "OPEN", path: "src/other.ts" })
    await waitFor(actor, (snapshot) => snapshot.context.selectedPath === "src/other.ts")

    actor.send({ type: "CLOSE", path: "src/other.ts" })
    await waitFor(actor, (snapshot) =>
      snapshot.matches({ document: { ready: "clean" } }) &&
      snapshot.context.selectedPath === "src/app.ts"
    )

    expect(actor.getSnapshot().context.openPaths).toEqual(["src/app.ts"])
  })

  it("guards a dirty file-tab close until discard is confirmed", async () => {
    const { actor } = start()
    actor.send({ type: "OPEN", path: "src/app.ts" })
    await waitFor(actor, (snapshot) => snapshot.matches({ document: { ready: "clean" } }))
    actor.send({ type: "EDIT", text: "unsaved" })

    actor.send({ type: "CLOSE", path: "src/app.ts" })
    expect(actor.getSnapshot().context.pendingDiscard).toEqual({
      type: "close",
      path: "src/app.ts"
    })
    expect(actor.getSnapshot().context.openPaths).toEqual(["src/app.ts"])

    actor.send({ type: "CONFIRM_DISCARD" })
    expect(actor.getSnapshot().matches({ document: "idle" })).toBe(true)
    expect(actor.getSnapshot().context.selectedPath).toBeNull()
    expect(actor.getSnapshot().context.openPaths).toEqual([])
  })

  it("cancels a dirty file-tab close without losing its draft", async () => {
    const { actor } = start()
    actor.send({ type: "OPEN", path: "src/app.ts" })
    await waitFor(actor, (snapshot) => snapshot.matches({ document: { ready: "clean" } }))
    actor.send({ type: "EDIT", text: "unsaved" })
    actor.send({ type: "CLOSE", path: "src/app.ts" })
    actor.send({ type: "CANCEL_DISCARD" })

    expect(actor.getSnapshot().context.pendingDiscard).toBeNull()
    expect(actor.getSnapshot().context.draft).toBe("unsaved")
    expect(actor.getSnapshot().context.openPaths).toEqual(["src/app.ts"])
  })

  it("opens text-shaped repository files directly in the IDE editor", async () => {
    const { actor } = start({
      read: vi.fn().mockResolvedValue(markdownPayload("# Preview", "sha256:md"))
    })
    actor.send({ type: "OPEN", path: "docs/spec.md" })
    await waitFor(actor, (snapshot) => snapshot.matches({ document: { ready: "clean" } }))
    expect(actor.getSnapshot().context.viewMode).toBe("edit")
  })

  it("opens tracked changes diff-first while retaining an explicit editor mode", async () => {
    const { actor } = start({
      list: vi.fn().mockResolvedValue([{ path: "src/app.ts", status: "modified" }])
    })
    await waitFor(actor, (snapshot) => snapshot.matches({ tree: "ready" }))
    actor.send({ type: "OPEN", path: "src/app.ts" })
    expect(actor.getSnapshot().context.viewMode).toBe("diff")
    actor.send({ type: "START_EDIT" })
    expect(actor.getSnapshot().context.viewMode).toBe("edit")
    actor.send({ type: "SHOW_DIFF" })
    expect(actor.getSnapshot().context.viewMode).toBe("diff")
  })

  it("retries a failed repository refresh", async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error("git busy"))
      .mockResolvedValueOnce([{ path: "src/app.ts", status: "modified" as const }])
    const { actor } = start({ list })
    await vi.waitFor(() => expect(actor.getSnapshot().matches({ tree: "error" })).toBe(true))

    actor.send({ type: "RETRY_TREE" })
    expect(actor.getSnapshot().matches({ tree: "loading" })).toBe(true)
    await vi.waitFor(() => expect(actor.getSnapshot().matches({ tree: "ready" })).toBe(true))
    expect(actor.getSnapshot().context.entries).toEqual([
      { path: "src/app.ts", status: "modified" }
    ])
    expect(actor.getSnapshot().context.treeError).toBeNull()
    expect(list).toHaveBeenCalledTimes(2)
  })

  it("queues one repository refresh when the Files view activates during initial loading", async () => {
    let resolveInitial:
      ((entries: ReadonlyArray<{ path: string; status: "clean" }>) => void) | undefined
    const list = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ReadonlyArray<{ path: string; status: "clean" }>>((resolve) => {
            resolveInitial = resolve
          })
      )
      .mockResolvedValueOnce([{ path: "src/created.ts", status: "clean" as const }])
    const { actor } = start({ list })

    actor.send({ type: "VIEW_ACTIVATED" })
    actor.send({ type: "VIEW_ACTIVATED" })
    expect(list).toHaveBeenCalledTimes(1)

    resolveInitial?.([])
    await waitFor(actor, () => list.mock.calls.length === 2)
    await waitFor(actor, (snapshot) => snapshot.matches({ tree: "ready" }))

    expect(list).toHaveBeenCalledTimes(2)
    expect(actor.getSnapshot().context.entries).toEqual([
      { path: "src/created.ts", status: "clean" }
    ])
  })

  it("refreshes a settled repository on later Files activations without clearing visible entries", async () => {
    let resolveRefresh:
      ((entries: ReadonlyArray<{ path: string; status: "modified" }>) => void) | undefined
    const originalEntries = [{ path: "src/app.ts", status: "clean" as const }]
    const list = vi
      .fn()
      .mockResolvedValueOnce(originalEntries)
      .mockImplementationOnce(
        () =>
          new Promise<ReadonlyArray<{ path: string; status: "modified" }>>((resolve) => {
            resolveRefresh = resolve
          })
      )
    const { actor } = start({ list })
    await waitFor(actor, (snapshot) => snapshot.matches({ tree: "ready" }))

    actor.send({ type: "VIEW_ACTIVATED" })

    expect(actor.getSnapshot().matches({ tree: "loading" })).toBe(true)
    expect(actor.getSnapshot().context.entries).toEqual(originalEntries)

    resolveRefresh?.([{ path: "src/app.ts", status: "modified" }])
    await waitFor(actor, (snapshot) => snapshot.matches({ tree: "ready" }))
    expect(actor.getSnapshot().context.entries).toEqual([
      { path: "src/app.ts", status: "modified" }
    ])
  })

  it("surfaces a queued refresh failure and recovers on a later Files activation", async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error("worktree not ready"))
      .mockRejectedValueOnce(new Error("worktree still not ready"))
      .mockResolvedValueOnce([{ path: "src/recovered.ts", status: "clean" as const }])
    const { actor } = start({ list })

    actor.send({ type: "VIEW_ACTIVATED" })
    await waitFor(actor, (snapshot) => snapshot.matches({ tree: "error" }))

    expect(list).toHaveBeenCalledTimes(2)
    expect(actor.getSnapshot().context.treeError).toBe("Couldn't refresh repository files.")
    actor.send({ type: "VIEW_ACTIVATED" })
    expect(actor.getSnapshot().matches({ tree: "loading" })).toBe(true)
    await waitFor(actor, (snapshot) => snapshot.matches({ tree: "ready" }))

    expect(actor.getSnapshot().context.entries).toEqual([
      { path: "src/recovered.ts", status: "clean" }
    ])
    expect(actor.getSnapshot().context.treeError).toBeNull()
  })

  it("restarts a repository refresh requested while one is already loading", async () => {
    let resolveFirst:
      ((entries: ReadonlyArray<{ path: string; status: "clean" }>) => void) | undefined
    const list = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ReadonlyArray<{ path: string; status: "clean" }>>((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockResolvedValueOnce([{ path: "src/fresh.ts", status: "clean" as const }])
    const { actor } = start({ list })

    actor.send({ type: "REFRESH_TREE" })
    await waitFor(actor, () => list.mock.calls.length === 2)
    await waitFor(actor, (snapshot) => snapshot.matches({ tree: "ready" }))

    expect(actor.getSnapshot().context.entries).toEqual([{ path: "src/fresh.ts", status: "clean" }])
    resolveFirst?.([{ path: "src/stale.ts", status: "clean" }])
  })
})
