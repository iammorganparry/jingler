import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it } from "vitest"
import { readPiSubagentTranscript } from "./pi-subagent-transcript.js"

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
  return { root, sessionFile }
}

describe("readPiSubagentTranscript", () => {
  it("maps a contained Pi child session into Jingler transcript messages", async () => {
    const { root, sessionFile } = await createChildSession()
    const messages = await readPiSubagentTranscript({
      sessionFile,
      trustedRoots: [root]
    })

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

  it("rejects a valid session file outside the trusted roots", async () => {
    const { sessionFile } = await createChildSession()
    const otherRoot = await mkdtemp(join(process.cwd(), ".other-child-root-"))
    temporaryRoots.push(otherRoot)

    await expect(readPiSubagentTranscript({
      sessionFile,
      trustedRoots: [otherRoot]
    })).rejects.toThrow("outside the trusted pi-subagents roots")
  })
})
