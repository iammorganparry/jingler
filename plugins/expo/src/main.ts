import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Activate } from "@jingler/plugin-sdk/host"
import type { ExpoSessionInput } from "./contracts.js"
import {
  ExpoPreviewController,
  type ExpoRuntimeDependencies,
  type ManagedProcess
} from "./runtime.js"

const inputOf = (value: unknown): ExpoSessionInput => {
  if (typeof value !== "object" || value === null) {
    throw new Error("The Expo command requires a session.")
  }
  const candidate = value as { sessionId?: unknown; worktreePath?: unknown }
  if (typeof candidate.sessionId !== "string" || candidate.sessionId.length === 0) {
    throw new Error("The Expo command requires a valid session id.")
  }
  if (candidate.worktreePath !== undefined && typeof candidate.worktreePath !== "string") {
    throw new Error("The Expo command received an invalid worktree path.")
  }
  return {
    sessionId: candidate.sessionId,
    ...(candidate.worktreePath ? { worktreePath: candidate.worktreePath } : {})
  }
}

const spawnExpo: ExpoRuntimeDependencies["spawn"] = async (
  executable,
  args,
  cwd,
  listeners
): Promise<ManagedProcess> => {
  const child = spawn(executable, [...args], {
    cwd,
    detached: true,
    env: { ...process.env, EXPO_NO_TELEMETRY: "1" },
    stdio: ["pipe", "pipe", "pipe"]
  })

  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", listeners.output)
  child.stderr.on("data", listeners.output)
  child.on("exit", listeners.exit)

  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve)
    child.once("error", reject)
  })

  return {
    write: (input) => child.stdin.write(input),
    terminate: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const signalGroup = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) return
        try {
          process.kill(-child.pid, signal)
        } catch {
          try {
            child.kill(signal)
          } catch {
            // The child exited between the state check and signal delivery.
          }
        }
      }
      signalGroup("SIGTERM")
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000))
      ])
      if (child.exitCode === null && child.signalCode === null) signalGroup("SIGKILL")
    }
  }
}

export const activate: Activate = (ctx) => {
  const capture: ExpoRuntimeDependencies["capture"] = async (udid) => {
    const directory = await mkdtemp(join(tmpdir(), "jingler-expo-"))
    const screenshot = join(directory, "simulator.png")
    try {
      const result = await ctx.exec(
        "xcrun",
        ["simctl", "io", udid, "screenshot", screenshot],
        { timeoutMs: 15_000 }
      )
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || "The iOS Simulator screenshot failed.")
      }
      return (await readFile(screenshot)).toString("base64")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  const controller = new ExpoPreviewController({
    platform: process.platform,
    exists: async (path) => {
      try {
        await readFile(path)
        return true
      } catch {
        return false
      }
    },
    exec: ctx.exec,
    spawn: spawnExpo,
    capture,
    openSimulator: async () => {
      const result = await ctx.exec("open", ["-a", "Simulator"], { timeoutMs: 10_000 })
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || "Simulator could not be opened.")
      }
    },
    now: Date.now
  })

  const commands = [
    ctx.commands.register("expo.inspect", (value) => controller.inspect(inputOf(value))),
    ctx.commands.register("expo.start", (value) => controller.start(inputOf(value))),
    ctx.commands.register("expo.status", (value) => controller.status(inputOf(value))),
    ctx.commands.register("expo.frame", (value) => controller.frame(inputOf(value))),
    ctx.commands.register("expo.reload", (value) => controller.reload(inputOf(value))),
    ctx.commands.register("expo.stop", (value) => controller.stop(inputOf(value))),
    ctx.commands.register("expo.open-simulator", () => controller.openSimulator())
  ]
  ctx.subscriptions.push(...commands, {
    dispose: () => {
      controller.dispose().catch((cause: unknown) => {
        ctx.log.warn(`Expo cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`)
      })
    }
  })
  ctx.log.info("Expo iOS Preview ready")
}
