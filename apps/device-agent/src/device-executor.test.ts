import type {
  CreateSessionFromIssueInput,
  CreateSessionFromPrInput,
  CreateSessionInput,
  RemoteSessionCommand,
  Project,
  Session
} from "@jingler/core"
import { describe, expect, it, vi } from "vitest"
import {
  DeviceOperationError,
  makeDeviceSessionCommandExecutor,
  type DeviceExecutorServices
} from "./device-executor.js"
import { SessionCommandHandler } from "./session-handler.js"
import { join } from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"

const resultSession = { id: "session_1" } as Session
const resultProject: Project = {
  id: "p_1",
  name: "jingler",
  path: "/repos/jingler",
  availability: "available",
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z"
}

const services = (): DeviceExecutorServices => ({
  create: vi.fn(async (_input: CreateSessionInput) => resultSession),
  createFromPr: vi.fn(async (_input: CreateSessionFromPrInput) => resultSession),
  createFromIssue: vi.fn(async (_input: CreateSessionFromIssueInput) => resultSession),
  continuation: vi.fn(async (_source: Session) => resultSession),
  listProjects: vi.fn(async () => [resultProject]),
  registerProject: vi.fn(async () => resultProject),
  createProjectDirectory: vi.fn(async () => resultProject),
  cloneProject: vi.fn(async () => resultProject),
  ensureProject: vi.fn(async () => resultProject),
  removeProject: vi.fn(async () => undefined),
  run: vi.fn(async (_sessionId, _input, emit) => {
    await emit({ _tag: "Assistant", text: "hello from device" })
  }),
  decideGate: vi.fn(async () => undefined),
  answerQuestion: vi.fn(async () => undefined),
  steer: vi.fn(async () => ({ status: "accepted" })),
  stop: vi.fn(async () => undefined),
  transcriptPage: vi.fn(async () => ({ messages: [], hasMore: false })),
  diff: vi.fn(async () => "diff --git"),
  files: vi.fn(async () => ["src/index.ts"]),
  branches: vi.fn(async () => ["main"]),
  archive: vi.fn(async () => resultSession),
  remove: vi.fn(async () => undefined),
  preparePublish: vi.fn(async () => ({
    version: 1 as const,
    sessionId: "session_1",
    githubSlug: "acme/widget",
    branch: "jingler/remote-publish",
    baseBranch: "main",
    commitSha: "a".repeat(40),
    commitMessage: "feat: publish remote work",
    prTitle: "Publish remote work",
    prBody: "Remote changes.",
    existingPrNumber: null
  })),
  completePublish: vi.fn(async () => resultSession)
})

const command = (operation: string, payload: unknown): RemoteSessionCommand => ({
  version: 1,
  commandId: "command_1",
  sessionId: "session_1",
  operation,
  payload
})

describe("device session command executor", () => {
  it("registers and lists projects through the owning device", async () => {
    const dependencies = services()
    const executor = makeDeviceSessionCommandExecutor(dependencies)
    const registered = await executor.execute(
      command("Projects.register", { path: "/repos/jingler" }),
      async () => undefined
    )
    const listed = await executor.execute(command("Projects.list", {}), async () => undefined)

    expect(dependencies.registerProject).toHaveBeenCalledWith({ path: "/repos/jingler" })
    expect(dependencies.listProjects).toHaveBeenCalled()
    expect(registered).toBe(resultProject)
    expect(listed).toEqual([resultProject])
  })

  it("ensures a missing project through the owning device", async () => {
    const dependencies = services()
    const result = await makeDeviceSessionCommandExecutor(dependencies).execute(
      command("Projects.ensure", { url: "git@github.com:iammorganparry/jingler.git", name: "jingler" }),
      async () => undefined
    )

    expect(dependencies.ensureProject).toHaveBeenCalledWith({
      url: "git@github.com:iammorganparry/jingler.git",
      name: "jingler"
    })
    expect(result).toBe(resultProject)
  })

  it("provisions a blank session through the device SessionStore boundary", async () => {
    const dependencies = services()
    const input: CreateSessionInput = {
      repoPath: "/repos/jingler",
      repoName: "jingler",
      cli: "codex",
      baseBranch: "main"
    }
    const result = await makeDeviceSessionCommandExecutor(dependencies).execute(
      command("Sessions.create", input),
      async () => undefined
    )
    expect(dependencies.create).toHaveBeenCalledWith(input)
    expect(result).toBe(resultSession)
  })

  it("streams Agent.run events before returning command completion", async () => {
    const dependencies = services()
    const emitted: Array<unknown> = []
    const result = await makeDeviceSessionCommandExecutor(dependencies).execute(
      command("Agent.run", { chatId: "chat_1", text: "hello" }),
      async (event) => { emitted.push(event) }
    )
    expect(dependencies.run).toHaveBeenCalledWith(
      "session_1",
      expect.objectContaining({ chatId: "chat_1", text: "hello" }),
      expect.any(Function)
    )
    expect(emitted).toEqual([
      { kind: "event", payload: { _tag: "Assistant", text: "hello from device" } }
    ])
    expect(result).toEqual({ status: "complete" })
  })

  it("streams canonical file-change evidence from the target runtime", async () => {
    const dependencies = {
      ...services(),
      run: vi.fn(async (_sessionId, _input, emit) => {
        await emit({
          _tag: "FileChanges",
          changes: {
            id: "change-set-1",
            callId: "tool-call-1",
            changes: [{
              status: "R",
              path: "src/new.ts",
              oldPath: "src/old.ts",
              added: 1,
              removed: 1,
              binary: false,
              noNewlineAtEnd: false,
              beforeBytes: 10,
              afterBytes: 12,
              preview: "rename",
              patchArtifactId: "artifact-1"
            }],
            totals: { added: 1, removed: 1 },
            authoritative: true,
            reconciledAt: "2026-08-10T00:00:00.000Z"
          }
        })
      })
    } satisfies DeviceExecutorServices
    const emitted: Array<unknown> = []

    await makeDeviceSessionCommandExecutor(dependencies).execute(
      command("Agent.run", { chatId: "chat_1", text: "rename it" }),
      async (event) => { emitted.push(event) }
    )

    expect(emitted).toEqual([{
      kind: "event",
      payload: expect.objectContaining({
        _tag: "FileChanges",
        changes: expect.objectContaining({
          authoritative: true,
          changes: [expect.objectContaining({ status: "R", oldPath: "src/old.ts" })]
        })
      })
    }])
  })

  it("routes live control operations to the same session and chat", async () => {
    const dependencies = services()
    const executor = makeDeviceSessionCommandExecutor(dependencies)
    await executor.execute(
      command("Agent.decideGate", { chatId: "chat_1", gateId: "gate_1", decision: "allow" }),
      async () => undefined
    )
    await executor.execute(
      command("Agent.answerQuestion", { chatId: "chat_1", requestId: "question_1", answers: [] }),
      async () => undefined
    )
    await executor.execute(
      command("Agent.stop", { chatId: "chat_1" }),
      async () => undefined
    )
    expect(dependencies.decideGate).toHaveBeenCalledWith(
      "session_1",
      { chatId: "chat_1", gateId: "gate_1", decision: "allow" }
    )
    expect(dependencies.answerQuestion).toHaveBeenCalledWith(
      "session_1",
      { chatId: "chat_1", requestId: "question_1", answers: [] }
    )
    expect(dependencies.stop).toHaveBeenCalledWith("session_1", "chat_1")
  })

  it("routes transcript diff files branches archive and delete without local fallback", async () => {
    const dependencies = services()
    const executor = makeDeviceSessionCommandExecutor(dependencies)
    await executor.execute(
      command("Sessions.transcriptPage", { chatId: "chat_1", limit: 50 }),
      async () => undefined
    )
    await executor.execute(command("Sessions.diff", {}), async () => undefined)
    await executor.execute(command("Workspace.files", {}), async () => undefined)
    await executor.execute(
      command("Workspace.branches", { repoPath: "/repos/jingler" }),
      async () => undefined
    )
    await executor.execute(
      command("Sessions.archive", { reason: "merged" }),
      async () => undefined
    )
    await executor.execute(command("Sessions.delete", {}), async () => undefined)
    expect(dependencies.transcriptPage).toHaveBeenCalledWith({ chatId: "chat_1", limit: 50 })
    expect(dependencies.diff).toHaveBeenCalledWith("session_1")
    expect(dependencies.files).toHaveBeenCalledWith("session_1", undefined)
    expect(dependencies.branches).toHaveBeenCalledWith("session_1", "/repos/jingler")
    expect(dependencies.archive).toHaveBeenCalledWith("session_1", "merged")
    expect(dependencies.remove).toHaveBeenCalledWith("session_1")
  })

  it("strips attachment bytes from remote transcript pages", async () => {
    const dependencies: DeviceExecutorServices = {
      ...services(),
      transcriptPage: vi.fn(async () => ({
      messages: [{
        id: "message_1",
        role: "user",
        streaming: false,
        createdAt: "2026-08-08T00:00:00.000Z",
        parts: [{
          _tag: "Image",
          attachment: {
            id: "attachment_1",
            name: "screen.png",
            mediaType: "image/png",
            data: "large-base64-payload"
          }
        }]
      }],
      hasMore: false
      }))
    }

    const result = await makeDeviceSessionCommandExecutor(dependencies).execute(
      command("Sessions.transcriptPage", { chatId: "chat_1", limit: 50 }),
      async () => undefined
    )

    expect(result).toMatchObject({
      messages: [{ parts: [{ attachment: { data: "" } }] }]
    })
  })

  it("fails unsupported operations with a typed device error", async () => {
    const executor = makeDeviceSessionCommandExecutor(services())
    await expect(
      executor.execute(command("Github.publish", {}), async () => undefined)
    ).rejects.toMatchObject({
      _tag: "DeviceOperationError",
      reason: "unsupported",
      operation: "Github.publish"
    } satisfies Partial<DeviceOperationError>)
  })

  it("prepares a remote push and links the desktop-created pull request", async () => {
    const dependencies = services()
    const executor = makeDeviceSessionCommandExecutor(dependencies)
    const prepared = await executor.execute(
      command("Github.preparePublish", {}),
      async () => undefined
    )
    const completed = await executor.execute(
      command("Github.completePublish", { prNumber: 73 }),
      async () => undefined
    )
    expect(dependencies.preparePublish).toHaveBeenCalledWith("session_1")
    expect(prepared).toMatchObject({ githubSlug: "acme/widget", commitSha: "a".repeat(40) })
    expect(dependencies.completePublish).toHaveBeenCalledWith("session_1", 73)
    expect(completed).toBe(resultSession)
  })

  it("rejects invalid pull request linkage before mutating the device session", async () => {
    const dependencies = services()
    await expect(
      makeDeviceSessionCommandExecutor(dependencies).execute(
        command("Github.completePublish", { prNumber: 0 }),
        async () => undefined
      )
    ).rejects.toMatchObject({ reason: "invalid-payload", operation: "Github.completePublish" })
    expect(dependencies.completePublish).not.toHaveBeenCalled()
  })

  it("fails malformed payloads before invoking a service", async () => {
    const dependencies = services()
    await expect(
      makeDeviceSessionCommandExecutor(dependencies).execute(
        command("Agent.stop", { chatId: 42 }),
        async () => undefined
      )
    ).rejects.toMatchObject({ reason: "invalid-payload", operation: "Agent.stop" })
    expect(dependencies.stop).not.toHaveBeenCalled()
  })

  it("integrates streamed Agent.run events with durable command completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-device-executor-"))
    try {
      const handler = new SessionCommandHandler(
        join(root, "ledger.json"),
        makeDeviceSessionCommandExecutor(services())
      )
      const events = await handler.handle(
        command("Agent.run", { chatId: "chat_1", text: "hello" })
      )
      expect(events.map((event) => event.kind)).toEqual(["event", "complete"])
      expect(events[0]?.payload).toEqual({ _tag: "Assistant", text: "hello from device" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
