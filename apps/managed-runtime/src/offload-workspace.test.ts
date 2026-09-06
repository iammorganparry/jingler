import type { OffloadAdmissionRequest } from "@jingler/core"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  executeOffloadCommand,
  primeOffloadWorkspace,
  restoreOffloadSnapshot,
  type OffloadSandbox
} from "./offload-workspace.js"

const request: OffloadAdmissionRequest = {
  version: 1,
  sessionId: "session_aaaaaaaaaaaaaaaa",
  idempotencyKey: "request_aaaaaaaaaaaaaaaa",
  repositorySlug: "jingler/example",
  snapshot: {
    version: 1,
    headSha: "a".repeat(40),
    digest: "b".repeat(64),
    bytes: 128
  },
  command: {
    source: { kind: "explicit", commandId: "verify-generated" },
    executable: "node",
    args: ["scripts/verify-generated.mjs", "literal;not-shell"],
    cwd: "."
  },
  limits: { timeoutSeconds: 60, snapshotBytes: 128, outputBytes: 1024 }
}

const timings = {
  queuedMs: 1,
  snapshotMs: 2,
  hydrationMs: 3,
  dependencyMs: 4
}

const sandbox = (executorResult: object) => {
  const writes = new Map<string, string>()
  const commands: string[] = []
  const value: OffloadSandbox = {
    exec: async (command) => {
      commands.push(command)
      return { success: true, stdout: "", stderr: "" }
    },
    writeFile: async (path, content) => {
      if (typeof content === "string") writes.set(path, content)
      return {}
    },
    readFile: async () => ({ content: JSON.stringify(executorResult) })
  }
  return { value, writes, commands }
}

const baseExecutorResult = {
  exitCode: 0,
  stdout: "clean",
  stderr: "",
  outputTruncated: false,
  timedOut: false,
  sourceMutated: false,
  commandMs: 5
}

describe("offload workspace result policy", () => {
  it.each([
    ["timed-out", { timedOut: true }],
    ["timed-out", { timedOut: true, sourceMutated: true, outputTruncated: true, exitCode: 2 }],
    ["source-mutated", { sourceMutated: true, outputTruncated: true, exitCode: 2 }],
    ["output-limit", { outputTruncated: true, exitCode: 2 }],
    ["source-mutated", { sourceMutated: true }],
    ["output-limit", { outputTruncated: true }],
    ["command-failed", { exitCode: 2 }]
  ] as const)("maps %s to a distinct terminal failure", async (reason, override) => {
    const harness = sandbox({ ...baseExecutorResult, ...override })
    const result = await Effect.runPromise(
      executeOffloadCommand(
        harness.value,
        "job_aaaaaaaaaaaaaaaa",
        request,
        "c".repeat(64),
        true,
        timings
      )
    )
    expect(result.state).toBe("failed")
    expect(result.failureReason).toBe(reason)
  })

  it("primes without dependencies and reports only the immutable sandbox marker as warm", async () => {
    const commands: string[] = []
    let primed = false
    const value: OffloadSandbox = {
      exec: async (command) => {
        commands.push(command)
        const stdout = primed ? "warm" : "cold"
        primed = true
        return { success: true, stdout, stderr: "" }
      },
      writeFile: async () => ({}),
      readFile: async () => ({ content: "" })
    }
    const first = await Effect.runPromise(
      primeOffloadWorkspace(value)
    )
    const second = await Effect.runPromise(
      primeOffloadWorkspace(value)
    )
    expect(first.warmSandbox).toBe(false)
    expect(second.warmSandbox).toBe(true)
    expect(commands).toHaveLength(2)
    expect(commands.every((command) => command.includes("jingler-offload-sandbox-ready"))).toBe(true)
  })

  it("fresh-installs dependencies with lifecycle scripts disabled for every restored job", async () => {
    const commands: string[] = []
    const value: OffloadSandbox = {
      exec: async (command) => {
        commands.push(command)
        return { success: true, stdout: command.includes(" manifest") ? "digest" : "", stderr: "" }
      },
      writeFile: async () => ({}),
      readFile: async () => ({ content: "" })
    }
    const restored = await Effect.runPromise(
      restoreOffloadSnapshot(value, "job_aaaaaaaaaaaaaaaa", new Uint8Array([1, 2, 3]), 128)
    )
    expect(restored.sourceDigest).toBe("digest")
    expect(commands.some((command) => command.includes("rm -rf node_modules"))).toBe(true)
    expect(commands.some((command) => command.includes("--ignore-scripts"))).toBe(true)
    expect(commands.some((command) => command.includes("jingler-offload-deps"))).toBe(false)
  })

  it("writes argv to a private file and invokes only the fixed executor", async () => {
    const harness = sandbox(baseExecutorResult)
    const result = await Effect.runPromise(
      executeOffloadCommand(
        harness.value,
        "job_aaaaaaaaaaaaaaaa",
        request,
        "c".repeat(64),
        true,
        timings
      )
    )
    expect(result.state).toBe("succeeded")
    expect([...harness.writes.values()].some((value) =>
      value.includes("literal;not-shell")
    )).toBe(true)
    expect(harness.commands).toHaveLength(1)
    expect(harness.commands[0]).not.toContain("literal;not-shell")
    expect(harness.commands[0]).toContain("/opt/jingler/offload-exec.mjs run")
  })
})
