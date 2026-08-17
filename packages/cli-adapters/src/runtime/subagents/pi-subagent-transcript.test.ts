import { appendFile, mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  makePiSubagentTranscriptReader,
  piSubagentTrustedSessionRoots,
  readPiSubagentTranscript
} from "./pi-subagent-transcript.js"

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true
  })))
})

const createChildSession = async () => {
  const root = await mkdtemp(join(process.cwd(), ".pi-child-transcript-"))
  temporaryRoots.push(root)
  const manager = SessionManager.create(process.cwd(), root)
  manager.appendMessage({
    role: "user",
    content: "Inspect the boundary",
    timestamp: 10
  })
  manager.appendMessage({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "I should inspect the public API" },
      { type: "text", text: "The boundary is contained." },
      {
        type: "toolCall",
        id: "tool-1",
        name: "workspace_read_file",
        arguments: { path: "src/public-api.ts" }
      },
      {
        type: "toolCall",
        id: "tool-2",
        name: "command_execute",
        arguments: { command: "pnpm test" }
      }
    ],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-test",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "toolUse",
    timestamp: 20
  })
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "tool-1",
    toolName: "workspace_read_file",
    content: [{
      type: "text",
      text: JSON.stringify({
        path: "src/public-api.ts",
        text: "export const publicApi = true"
      })
    }],
    isError: false,
    timestamp: 30
  })
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "tool-2",
    toolName: "command_execute",
    content: [{
      type: "text",
      text: JSON.stringify({
        command: "pnpm test",
        exitCode: 1,
        stdout: "1 passed",
        stderr: "1 failed"
      })
    }],
    isError: true,
    timestamp: 40
  })
  const sessionFile = manager.getSessionFile()
  if (!sessionFile) throw new Error("Expected a persisted child session")
  return { root, sessionFile, manager }
}

describe("readPiSubagentTranscript", () => {
  it("maps a contained Pi child session into Jingler transcript messages", async () => {
    const { root, sessionFile } = await createChildSession()
    const messages = await Effect.runPromise(readPiSubagentTranscript({
      sessionFile,
      trustedRoots: piSubagentTrustedSessionRoots(join(root, "parent.jsonl"))
    }))

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: "user", parts: [{ _tag: "Text" }] })
    expect(messages[1]).toMatchObject({
      role: "assistant",
      parts: [
        { _tag: "Thinking" },
        { _tag: "Text", text: "The boundary is contained." },
        {
          _tag: "Tool",
          tool: {
            id: "tool-1",
            name: "workspace_read_file",
            target: "src/public-api.ts",
            status: "success",
            output: "export const publicApi = true"
          }
        },
        {
          _tag: "Tool",
          tool: {
            id: "tool-2",
            name: "command_execute",
            target: "pnpm test",
            status: "error",
            meta: "exit 1",
            output: "1 passed\n1 failed"
          }
        }
      ]
    })
  })

  it("reads only appended JSONL entries and preserves existing identities", async () => {
    const { root, sessionFile, manager } = await createChildSession()
    const reader = Effect.runSync(makePiSubagentTranscriptReader())
    const openSession = vi.spyOn(SessionManager, "open")
    const input = {
      sessionFile,
      trustedRoots: piSubagentTrustedSessionRoots(join(root, "parent.jsonl"))
    }
    const first = await Effect.runPromise(reader.read(input))
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Appended progress" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: "stop",
      timestamp: 50
    })

    const second = await Effect.runPromise(reader.read(input))

    expect(second.slice(0, first.length).map(({ id }) => id))
      .toEqual(first.map(({ id }) => id))
    expect(openSession).toHaveBeenCalledOnce()
    expect(second.at(-1)).toMatchObject({
      role: "assistant",
      parts: [{ _tag: "Text", text: "Appended progress" }]
    })

    manager.appendMessage({
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "tool-late",
        name: "workspace_read_file",
        arguments: { path: "src/late.ts" }
      }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: "toolUse",
      timestamp: 60
    })
    await Effect.runPromise(reader.read(input))
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "tool-late",
      toolName: "workspace_read_file",
      content: [{ type: "text", text: "late output" }],
      isError: false,
      timestamp: 70
    })
    const settled = await Effect.runPromise(reader.read(input))
    expect(settled.flatMap(({ parts }) => parts)).toContainEqual(expect.objectContaining({
      _tag: "Tool",
      tool: expect.objectContaining({
        id: "tool-late",
        status: "success",
        output: "late output"
      })
    }))
  })

  it("rebuilds the cursor when appended entries switch the active branch", async () => {
    const { root, sessionFile, manager } = await createChildSession()
    const reader = Effect.runSync(makePiSubagentTranscriptReader())
    const input = {
      sessionFile,
      trustedRoots: piSubagentTrustedSessionRoots(join(root, "parent.jsonl"))
    }
    const before = await Effect.runPromise(reader.read(input))
    const firstMessage = manager.getEntries().find((entry) => entry.type === "message")
    if (!firstMessage) throw new Error("Expected a branch point")
    manager.branch(firstMessage.id)
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Replacement branch" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: "stop",
      timestamp: 80
    })

    const after = await Effect.runPromise(reader.read(input))

    expect(before.some(({ parts }) => parts.some((part) =>
      part._tag === "Text" && part.text === "The boundary is contained."
    ))).toBe(true)
    expect(after.some(({ parts }) => parts.some((part) =>
      part._tag === "Text" && part.text === "The boundary is contained."
    ))).toBe(false)
    expect(after.at(-1)).toMatchObject({
      role: "assistant",
      parts: [{ _tag: "Text", text: "Replacement branch" }]
    })
  })

  it("waits for a complete JSONL record before advancing its cursor", async () => {
    const { root, sessionFile } = await createChildSession()
    const reader = Effect.runSync(makePiSubagentTranscriptReader())
    const input = {
      sessionFile,
      trustedRoots: piSubagentTrustedSessionRoots(join(root, "parent.jsonl"))
    }
    const before = await Effect.runPromise(reader.read(input))
    const line = JSON.stringify({
      type: "message",
      id: "partial-message",
      parentId: null,
      timestamp: "2026-08-16T00:00:00.000Z",
      message: {
        role: "user",
        content: "Complete after two writes",
        timestamp: 80
      }
    })
    const split = Math.floor(line.length / 2)
    await appendFile(sessionFile, line.slice(0, split))
    expect(await Effect.runPromise(reader.read(input))).toEqual(before)
    await appendFile(sessionFile, `${line.slice(split)}\n`)

    const after = await Effect.runPromise(reader.read(input))

    expect(after.at(-1)).toMatchObject({
      role: "user",
      parts: [{ _tag: "Text", text: "Complete after two writes" }]
    })
  })

  it("resets the cursor when the session file is atomically replaced", async () => {
    const original = await createChildSession()
    const replacement = await createChildSession()
    replacement.manager.appendMessage({
      role: "user",
      content: "Replacement session",
      timestamp: 60
    })
    const reader = Effect.runSync(makePiSubagentTranscriptReader())
    const input = {
      sessionFile: original.sessionFile,
      trustedRoots: piSubagentTrustedSessionRoots(join(original.root, "parent.jsonl"))
    }
    await Effect.runPromise(reader.read(input))
    await rename(replacement.sessionFile, original.sessionFile)

    const messages = await Effect.runPromise(reader.read(input))

    expect(messages.at(-1)).toMatchObject({
      role: "user",
      parts: [{ _tag: "Text", text: "Replacement session" }]
    })
  })

  it("rejects a valid session file outside the trusted roots", async () => {
    const { sessionFile } = await createChildSession()
    const otherRoot = await mkdtemp(join(process.cwd(), ".other-child-root-"))
    temporaryRoots.push(otherRoot)

    await expect(Effect.runPromise(readPiSubagentTranscript({
      sessionFile,
      trustedRoots: [otherRoot]
    }))).rejects.toThrow("outside the trusted pi-subagents roots")
  })

  it("rejects a symlink that escapes an allowed transcript root", async () => {
    const { sessionFile } = await createChildSession()
    const trustedRoot = await mkdtemp(join(process.cwd(), ".trusted-child-root-"))
    temporaryRoots.push(trustedRoot)
    const link = join(trustedRoot, "linked-session.jsonl")
    await mkdir(trustedRoot, { recursive: true })
    await symlink(sessionFile, link)

    await expect(Effect.runPromise(readPiSubagentTranscript({
      sessionFile: link,
      trustedRoots: [trustedRoot]
    }))).rejects.toThrow("outside the trusted pi-subagents roots")
  })

})
