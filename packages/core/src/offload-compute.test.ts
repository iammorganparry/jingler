import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  canTransitionOffloadJob,
  classifyOffloadCommand,
  parseObservedAgentShellCommand,
  DEFAULT_OFFLOAD_COMPUTE_SETTINGS,
  OFFLOAD_OUTPUT_MAX_BYTES,
  OFFLOAD_SNAPSHOT_MAX_BYTES,
  OFFLOAD_TIMEOUT_MAX_SECONDS,
  OffloadComputeSettings,
  OffloadExplicitCommand,
  OffloadJobEvent,
  OffloadJobLimits,
  OffloadJobResult,
  OffloadSnapshotIdentity,
  type ObservedAgentCommand
} from "./offload-compute.js"

const decode = <A, I>(schema: Schema.Schema<A, I>, value: unknown) =>
  Schema.decodeUnknownEither(schema)(value, { onExcessProperty: "error" })

const command = (
  overrides: Partial<ObservedAgentCommand> = {}
): ObservedAgentCommand => ({
  executable: "pnpm",
  args: ["lint"],
  cwd: ".",
  interactive: false,
  usesShellFeatures: false,
  mutatesSource: false,
  environmentKeys: [],
  ...overrides
})

const enabled = {
  enabled: true,
  explicitCommands: []
} as const

const timings = {
  queuedMs: 1,
  snapshotMs: 2,
  hydrationMs: 3,
  dependencyMs: 4,
  commandMs: 5
}

const result = {
  version: 1,
  jobId: "job_aaaaaaaaaaaaaaaa",
  state: "succeeded",
  exitCode: 0,
  failureReason: null,
  stdout: "clean",
  stderr: "",
  outputTruncated: false,
  timings
} as const

describe("Offload Compute shell observation", () => {
  it("turns quoting and escaping into literal argv", () => {
    expect(parseObservedAgentShellCommand(
      "pnpm run test -- --name 'literal; value' escaped\\ value"
    )).toMatchObject({
      complete: true,
      command: {
        executable: "pnpm",
        args: ["run", "test", "--", "--name", "literal; value", "escaped value"],
        usesShellFeatures: false
      }
    })
  })

  it.each([
    "pnpm test && echo done",
    "pnpm test > output.txt",
    "pnpm test $EXTRA",
    "pnpm test\nrm -rf .",
    "pnpm 'test"
  ])("fails closed for shell-composed source: %s", (source) => {
    expect(parseObservedAgentShellCommand(source).command.usesShellFeatures).toBe(true)
  })

  it("marks stateful commands local without blocking read-only presets", () => {
    expect(parseObservedAgentShellCommand("git checkout main").command.mutatesSource).toBe(true)
    expect(parseObservedAgentShellCommand("pnpm install").command.mutatesSource).toBe(true)
    expect(parseObservedAgentShellCommand("pnpm build").command.mutatesSource).toBe(false)
  })
})

describe("Offload Compute command classification", () => {
  it.each([
    ["lint", "pnpm", ["lint"]],
    ["typecheck", "npm", ["run", "typecheck"]],
    ["test", "yarn", ["test"]],
    ["build", "bun", ["run", "build"]]
  ] as const)("classifies the %s preset", (preset, executable, args) => {
    expect(classifyOffloadCommand(enabled, command({ executable, args }))).toEqual({
      target: "offload",
      command: {
        source: { kind: "preset", preset },
        executable,
        args,
        cwd: "."
      }
    })
  })

  it("keeps commands local while disabled", () => {
    expect(classifyOffloadCommand(DEFAULT_OFFLOAD_COMPUTE_SETTINGS, command())).toEqual({
      target: "local",
      reason: "disabled"
    })
  })

  it.each([
    ["interactive", { interactive: true }, "interactive"],
    ["shell-composed", { usesShellFeatures: true }, "shell-features"],
    ["stateful", { mutatesSource: true }, "stateful"],
    ["secret-bearing", { environmentKeys: ["GITHUB_TOKEN"] }, "secret-environment"],
    ["unknown", { args: ["dev"] }, "unknown-command"]
  ] as const)("keeps %s commands local", (_name, overrides, reason) => {
    expect(classifyOffloadCommand(enabled, command(overrides))).toEqual({
      target: "local",
      reason
    })
  })

})

describe("Offload Compute explicit command classification", () => {
  it("routes an exact project allowlist command", () => {
    const settings = {
      enabled: true,
      explicitCommands: [
        {
          id: "verify-generated",
          command: {
            executable: "node",
            args: ["scripts/verify-generated.mjs"],
            cwd: "."
          }
        }
      ]
    } as const
    expect(
      classifyOffloadCommand(
        settings,
        command({ executable: "node", args: ["scripts/verify-generated.mjs"] })
      )
    ).toEqual({
      target: "offload",
      command: {
        source: { kind: "explicit", commandId: "verify-generated" },
        executable: "node",
        args: ["scripts/verify-generated.mjs"],
        cwd: "."
      }
    })
    expect(
      classifyOffloadCommand(
        settings,
        command({ executable: "node", args: ["scripts/other.mjs"] })
      )
    ).toEqual({ target: "local", reason: "unknown-command" })
  })
})

describe("Offload Compute schemas", () => {
  it("accepts bounded settings, commands, snapshots, events, and results", () => {
    expect(Either.isRight(decode(OffloadComputeSettings, enabled))).toBe(true)
    expect(
      Either.isRight(
        decode(OffloadExplicitCommand, {
          executable: "pnpm",
          args: ["--filter", "@jingler/desktop", "typecheck"],
          cwd: "apps/desktop"
        })
      )
    ).toBe(true)
    expect(
      Either.isRight(
        decode(OffloadSnapshotIdentity, {
          version: 1,
          headSha: "a".repeat(40),
          digest: "b".repeat(64),
          bytes: OFFLOAD_SNAPSHOT_MAX_BYTES
        })
      )
    ).toBe(true)
    expect(Either.isRight(decode(OffloadJobResult, result))).toBe(true)
    expect(
      Either.isRight(
        decode(OffloadJobEvent, {
          version: 1,
          jobId: result.jobId,
          sequence: 1,
          kind: "result",
          result
        })
      )
    ).toBe(true)
  })

  it.each([
    { executable: "/bin/bash", args: ["-lc", "pnpm lint"], cwd: "." },
    { executable: "pnpm", args: ["lint\nrm -rf ."], cwd: "." },
    { executable: "pnpm", args: ["lint"], cwd: "/tmp/repo" },
    { executable: "pnpm", args: ["lint"], cwd: "../repo" },
    { executable: "pnpm", args: ["lint"], cwd: "apps\\desktop" },
    { executable: "pnpm", args: ["lint"], cwd: "apps//desktop" },
    { executable: "pnpm", args: ["lint"], cwd: ".", shell: "bash" }
  ])("rejects unsafe or shell-shaped command %#", (candidate) => {
    expect(Either.isLeft(decode(OffloadExplicitCommand, candidate))).toBe(true)
  })

})

describe("Offload Compute limits and lifecycle", () => {
  it("rejects oversized limits and payloads", () => {
    expect(
      Either.isLeft(
        decode(OffloadJobLimits, {
          timeoutSeconds: OFFLOAD_TIMEOUT_MAX_SECONDS + 1,
          snapshotBytes: OFFLOAD_SNAPSHOT_MAX_BYTES,
          outputBytes: OFFLOAD_OUTPUT_MAX_BYTES
        })
      )
    ).toBe(true)
    expect(
      Either.isLeft(
        decode(OffloadSnapshotIdentity, {
          version: 1,
          headSha: "a".repeat(40),
          digest: "b".repeat(64),
          bytes: OFFLOAD_SNAPSHOT_MAX_BYTES + 1
        })
      )
    ).toBe(true)
    expect(
      Either.isLeft(
        decode(OffloadJobResult, {
          ...result,
          stdout: "x".repeat(OFFLOAD_OUTPUT_MAX_BYTES + 1)
        })
      )
    ).toBe(true)
  })

  it("allows only declared lifecycle transitions", () => {
    expect(canTransitionOffloadJob("capturing", "uploading")).toBe(true)
    expect(canTransitionOffloadJob("running", "succeeded")).toBe(true)
    expect(canTransitionOffloadJob("running", "capturing")).toBe(false)
    expect(canTransitionOffloadJob("succeeded", "running")).toBe(false)
    expect(canTransitionOffloadJob("cancelled", "cancelled")).toBe(false)
  })
})
