import { Effect, Schema } from "effect"
import { describe, expect, it, vi } from "vitest"
import type { MemoryAttachment } from "../../memory.js"
import type { MemoryAttachmentServiceShape } from "../../memory-session.js"
import {
  makeToolMemory,
  MAX_TOOL_MEMORY_FAILURES,
  shellCommandHead,
  toolMemorySignature
} from "./tool-memory.js"
import { ToolRegistry } from "./tool-registry.js"

const attachment = (instructions: string): MemoryAttachment => ({
  server: {
    name: "jingler-memory",
    url: "http://127.0.0.1:9000/mcp",
    headers: { authorization: "Bearer scoped" }
  },
  instructions
})

const memoryService = (
  instructions: string,
  calls: string[] = []
): MemoryAttachmentServiceShape => ({
  attachment: (query) => {
    calls.push(query ?? "")
    return Effect.succeed(attachment(instructions))
  }
})

const commandRegistry = (
  execute: () => Promise<unknown>,
  memory: ReturnType<typeof makeToolMemory>
): ToolRegistry => {
  const registry = new ToolRegistry({
    memory,
    observer: {
      started: () => Effect.succeed({ cwd: "/workspace", tree: "before" }),
      settled: (_request, _risk, _state, result) =>
        Effect.succeed({
          id: "changes-1",
          callId: "call-1",
          changes: [],
          totals: { added: 0, removed: 0 },
          authoritative: result.status === "success",
          reconciledAt: "2026-08-15T12:00:00.000Z"
        })
    }
  })
  registry.register({
    id: "command_execute",
    version: "1",
    description: "Run a command.",
    input: Schema.Struct({ command: Schema.String }),
    risk: "execute",
    roles: ["conversation"],
    modes: ["auto"],
    timeoutMs: 1_000,
    outputBudget: 1_000,
    cancellable: true,
    idempotency: "safe",
    execute
  })
  return registry
}

const request = (callId: string) => ({
  id: "command_execute",
  arguments: { command: "API_KEY=private pnpm test /Users/alice/project" },
  role: "conversation" as const,
  mode: "auto" as const,
  callId
})

describe("tool memory signatures", () => {
  it.each([
    ["pnpm test --filter api", "pnpm test"],
    ["API_KEY=private git status /Users/alice/project", "git status"],
    ["sudo npm install secret-package", "npm install"],
    ["/usr/local/bin/docker compose -f private.yml", "docker compose"],
    ["echo customerName", "echo"],
    ["printf secretValue", "printf"],
    ["python privateScript", "python"],
    ["rm confidentialFile", "rm"]
  ])("keeps only a safe command head for %s", (command, expected) => {
    expect(shellCommandHead(command)).toBe(expected)
  })

  it("uses only the tool id for non-shell tools", () => {
    expect(toolMemorySignature({
      id: "mcp__provider__deploy",
      arguments: { token: "secret", path: "/Users/alice/project" }
    })).toBe("mcp__provider__deploy")
  })
})

describe("tool-call-scoped recall", () => {
  it("pauses once with a cited advisory before executing a retried signature", async () => {
    const calls: string[] = []
    const memory = makeToolMemory({
      runId: "run-1",
      memory: memoryService(
        "<team-memory>policy</team-memory>\n<recalled-memories><recalled-memory>{\"pageId\":\"cli-gotcha\",\"revisionId\":\"rev-1\"}</recalled-memory></recalled-memories>",
        calls
      )
    })
    const execute = vi.fn(async () => ({ ok: true }))
    const registry = commandRegistry(execute, memory)

    const first = await Effect.runPromise(registry.execute(request("call-1")))
    expect(execute).not.toHaveBeenCalled()
    const second = await Effect.runPromise(registry.execute(request("call-2")))

    expect(first.status).toBe("error")
    expect(first.error).toMatchObject({ retryable: true })
    expect(first.advisory).toContain("pageId")
    expect(first.advisory).toContain("revisionId")
    expect(second.value).toEqual({ ok: true })
    expect(execute).toHaveBeenCalledOnce()
    expect(second.advisory).toBeUndefined()
    expect(calls).toEqual(["Tool: command_execute:pnpm:test"])
  })

  it("records a bounded failed-call candidate without altering the error", async () => {
    const memory = makeToolMemory({
      runId: "run-2",
      memory: memoryService("<recalled-memories>no accepted matches</recalled-memories>")
    })
    const registry = commandRegistry(async () => {
      throw new Error(`bad flag ${"x".repeat(2_000)} api_key=private-value`)
    }, memory)

    const result = await Effect.runPromise(registry.execute(request("call-1")))

    expect(result.status).toBe("error")
    expect(result.error?.message).toContain("bad flag")
    expect(registry.toolMemoryFailures()).toHaveLength(1)
    expect(registry.toolMemoryFailures()[0]).toMatchObject({
      signature: "command_execute:pnpm:test",
      toolId: "command_execute"
    })
    expect(registry.toolMemoryFailures()[0]!.message.length).toBeLessThanOrEqual(1_000)
    expect(registry.toolMemoryFailures()[0]!.message).not.toContain("private-value")
  })

  it("retains only the newest bounded failed-call candidates", async () => {
    let attempt = 0
    const memory = makeToolMemory({
      runId: "run-bounded-failures",
      memory: memoryService("<recalled-memories>no accepted matches</recalled-memories>")
    })
    const registry = commandRegistry(async () => {
      attempt += 1
      throw new Error(`failure-${attempt}`)
    }, memory)

    for (let index = 0; index < MAX_TOOL_MEMORY_FAILURES + 5; index += 1) {
      await Effect.runPromise(registry.execute(request(`call-${index}`)))
    }

    expect(registry.toolMemoryFailures()).toHaveLength(MAX_TOOL_MEMORY_FAILURES)
    expect(registry.toolMemoryFailures().map(({ message }) => message)).toEqual([
      "failure-6",
      "failure-7",
      "failure-8"
    ])
  })

  it("bounds a stalled recall and still executes the tool", async () => {
    const memory = makeToolMemory({
      runId: "run-timeout",
      memory: { attachment: () => Effect.never }
    })
    const registry = commandRegistry(async () => "ran", memory)
    const startedAt = Date.now()

    const result = await Effect.runPromise(registry.execute(request("call-1")))

    expect(result.value).toBe("ran")
    expect(Date.now() - startedAt).toBeLessThan(2_250)
  })

  it("fails open when recall rejects", async () => {
    const execute = vi.fn(async () => "ran")
    const memory = makeToolMemory({
      runId: "run-3",
      memory: { attachment: () => Effect.die("offline") }
    })
    const registry = commandRegistry(execute, memory)

    const result = await Effect.runPromise(registry.execute(request("call-1")))

    expect(result.value).toBe("ran")
    expect(result.advisory).toBeUndefined()
    expect(execute).toHaveBeenCalledOnce()
  })
})
