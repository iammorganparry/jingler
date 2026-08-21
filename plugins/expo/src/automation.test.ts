import { describe, expect, it, vi } from "vitest"
import {
  ExpoAutomationController,
  parseAutomationResult,
  resolveExpoBundleIdentifier,
  spawnAutomationCommand,
  decodeAutomationAction,
  type AutomationCommandRunner
} from "./automation.js"

type DriverResult =
  | { readonly ok: true; readonly kind: string; readonly value: string | null }
  | { readonly ok: false; readonly kind: string; readonly error: string }

const encodedResult = (value: DriverResult): string =>
  `JINGLER_EXPO_RESULT:${Buffer.from(JSON.stringify(value)).toString("base64")}`

const signal = () => new AbortController().signal

describe("Expo automation protocol", () => {
  it("accepts bounded semantic actions and rejects ambiguous selectors", () => {
    expect(decodeAutomationAction({
      kind: "tap",
      selector: { identifier: "save" },
      timeout: 30
    })).toEqual({ kind: "tap", selector: { identifier: "save" }, timeout: 30 })
    expect(() => decodeAutomationAction({
      kind: "tap",
      selector: { identifier: "save", label: "Save" }
    })).toThrow("exactly one")
    expect(() => decodeAutomationAction({ kind: "swipe", direction: "diagonal" }))
      .toThrow()
  })

  it("decodes the bounded XCTest marker and surfaces driver errors", () => {
    expect(parseAutomationResult(encodedResult({ ok: true, kind: "tap", value: "tapped" })))
      .toEqual({ ok: true, kind: "tap", value: "tapped" })
    expect(() => parseAutomationResult(encodedResult({
      ok: false,
      kind: "error",
      error: "No matching accessibility element was found."
    }))).toThrow("No matching")
    expect(() => parseAutomationResult("ordinary xcode output")).toThrow("no Expo automation result")
  })

  it("resolves a development-client bundle id and falls back to Expo Go", async () => {
    const configured = vi.fn<AutomationCommandRunner>(async () => ({
      code: 0,
      stdout: JSON.stringify({ ios: { bundleIdentifier: "com.acme.mobile" } }),
      stderr: ""
    }))
    await expect(resolveExpoBundleIdentifier("/repo/mobile", signal(), configured))
      .resolves.toBe("com.acme.mobile")
    expect(configured).toHaveBeenCalledWith(
      "/repo/mobile/node_modules/.bin/expo",
      ["config", "--json"],
      expect.objectContaining({ cwd: "/repo/mobile" })
    )
    const unavailable = vi.fn<AutomationCommandRunner>(async () => ({ code: 1, stdout: "", stderr: "no config" }))
    await expect(resolveExpoBundleIdentifier("/repo/mobile", signal(), unavailable))
      .resolves.toBe("host.exp.Exponent")
  })
})

describe("ExpoAutomationController", () => {
  it("builds once and serializes XCTest actions", async () => {
    let releaseFirst: (() => void) | undefined
    let testCalls = 0
    const run = vi.fn<AutomationCommandRunner>(async (command, args) => {
      if (command.endsWith("/expo")) {
        return { code: 0, stdout: JSON.stringify({ ios: {} }), stderr: "" }
      }
      if (args.includes("build-for-testing")) return { code: 0, stdout: "built", stderr: "" }
      testCalls += 1
      if (testCalls === 1) await new Promise<void>((resolve) => { releaseFirst = resolve })
      return {
        code: 0,
        stdout: encodedResult({ ok: true, kind: "describe", value: `result-${testCalls}` }),
        stderr: ""
      }
    })
    const automation = new ExpoAutomationController({
      projectPath: "/plugin/automation.xcodeproj",
      derivedDataPath: "/tmp/derived",
      runCommand: run
    })
    const first = automation.run({ kind: "describe" }, "/repo/mobile", "sim-1", signal())
    await vi.waitFor(() => expect(testCalls).toBe(1))
    const second = automation.run({ kind: "describe" }, "/repo/mobile", "sim-1", signal())
    await Promise.resolve()
    expect(testCalls).toBe(1)
    releaseFirst?.()

    await expect(first).resolves.toMatchObject({ value: "result-1" })
    await expect(second).resolves.toMatchObject({ value: "result-2" })
    expect(run.mock.calls.filter(([, args]) => args.includes("build-for-testing"))).toHaveLength(1)
  })

  it("honors aborts and reports xcodebuild failures", async () => {
    const aborted = new AbortController()
    aborted.abort()
    const automation = new ExpoAutomationController({
      projectPath: "/plugin/automation.xcodeproj",
      derivedDataPath: "/tmp/derived",
      runCommand: vi.fn()
    })
    await expect(automation.run({ kind: "describe" }, "/repo", "sim", aborted.signal))
      .rejects.toThrow("cancelled")

    const failed = new ExpoAutomationController({
      projectPath: "/plugin/automation.xcodeproj",
      derivedDataPath: "/tmp/derived",
      runCommand: vi.fn(async () => ({ code: 1, stdout: "", stderr: "Swift compile failed" }))
    })
    await expect(failed.run({ kind: "describe" }, "/repo", "sim", signal()))
      .rejects.toThrow("Swift compile failed")
  })

  it("terminates a spawned command when its signal aborts", async () => {
    const controller = new AbortController()
    const command = spawnAutomationCommand(
      process.execPath,
      ["-e", "setTimeout(() => {}, 10000)"],
      { signal: controller.signal, timeoutMs: 20_000 }
    )
    controller.abort()
    await expect(command).rejects.toThrow("cancelled")
  })
})
