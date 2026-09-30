import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { NativeSidecarOwnerStore } from "./native-sidecar-owner-store.js"

const roots: string[] = []
const root = async () => {
  const value = await mkdtemp(join(tmpdir(), "jingler-sidecar-owners-"))
  roots.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })))
})

describe("native sidecar owner store", () => {
  it("atomically replaces one chat owner without storing secrets", async () => {
    const directory = await root()
    const file = join(directory, "owners.json")
    const store = new NativeSidecarOwnerStore(file)
    const base = {
      sessionId: "session-1",
      chatId: "chat-1",
      runtimeId: "codex" as const,
      targetId: "device:test",
      cwd: "/workspace/non-default",
      parentRuntimeSessionId: "pi-parent"
    }
    await Promise.all([
      store.put({ ...base, continuationAlias: "/pi/first.jsonl", token: "secret" } as never),
      store.put({ ...base, continuationAlias: "/pi/second.jsonl" })
    ])

    const owners = await store.list()
    expect(owners).toHaveLength(1)
    expect(owners[0]).toMatchObject({ ...base, continuationAlias: "/pi/second.jsonl" })
    const raw = await readFile(file, "utf8")
    expect(raw).not.toContain("token")
    await expect(readdir(directory)).resolves.toEqual(["owners.json"])
  })

  it("retains multiple recovered sidecars for one chat", async () => {
    const directory = await root()
    const store = new NativeSidecarOwnerStore(join(directory, "owners.json"))
    await store.put({
      sessionId: "session-1",
      chatId: "chat-1",
      runtimeId: "claude",
      targetId: "desktop",
      cwd: "/workspace",
      continuationAlias: "/pi/active.jsonl",
      parentRuntimeSessionId: "pi-active"
    })
    await store.put({
      sessionId: "session-1",
      chatId: "chat-1",
      runtimeId: "claude",
      targetId: "desktop",
      cwd: "/workspace",
      continuationAlias: "/pi/current.jsonl",
      parentRuntimeSessionId: "pi-current"
    })

    await expect(store.list()).resolves.toHaveLength(2)
  })

  it("prunes expired owners and removes one exact sidecar without deleting siblings", async () => {
    const directory = await root()
    const file = join(directory, "owners.json")
    const entry = (parentRuntimeSessionId: string, updatedAt: number) => ({
      version: 1,
      sessionId: "session-1",
      chatId: "chat-1",
      runtimeId: "codex",
      targetId: "device:test",
      cwd: "/workspace/non-default",
      continuationAlias: `/pi/${parentRuntimeSessionId}.jsonl`,
      parentRuntimeSessionId,
      updatedAt
    })
    await writeFile(file, `${JSON.stringify([
      entry("expired", 10),
      entry("current", 100),
      entry("sibling", 100)
    ])}\n`)
    const store = new NativeSidecarOwnerStore(file)

    await expect(store.pruneExpired(50)).resolves.toEqual([
      entry("current", 100),
      entry("sibling", 100)
    ])
    await store.removeExact(entry("current", 100))
    await expect(store.list()).resolves.toEqual([entry("sibling", 100)])
  })

  it("fails closed on unreadable ownership and keeps the file", async () => {
    const directory = await root()
    const file = join(directory, "owners.json")
    await writeFile(file, '[{"version":1,"sessionId":"session-1"}]\n')
    const store = new NativeSidecarOwnerStore(file)

    await expect(store.list()).rejects.toThrow("invalid entry")
    await expect(readFile(file, "utf8")).resolves.toContain("session-1")
  })
})
