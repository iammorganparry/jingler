import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type {
  Activate,
  AgentToolDefinition,
  AgentToolExecutionContext,
  HostContext
} from "@jingler/plugin-sdk/host"
import * as v from "valibot"
import { decodeExpoCommandInput } from "./contracts.js"
import {
  AutomationSelectorSchema,
  AutomationTimeoutSchema,
  ExpoAutomationController,
  decodeAutomationAction,
  type AutomationAction
} from "./automation.js"
import {
  ExpoPreviewController,
  type ExpoRuntimeDependencies,
  type ManagedProcess
} from "./runtime.js"

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
  child.stdin.on("error", () => undefined)
  child.on("exit", listeners.exit)

  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve)
    child.once("error", reject)
  })

  return {
    write: (input) => new Promise((resolve, reject) => {
      child.stdin.write(input, (error) => error ? reject(error) : resolve())
    }),
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

const AUTOMATION_PROJECT_PATH = "../automation/ExpoAutomation.xcodeproj"

type Preview = Pick<
  ExpoPreviewController,
  "dispose" | "frame" | "inspect" | "openSimulator" | "reload" | "start" | "status" | "stop"
>
type AutomationRunner = Pick<ExpoAutomationController, "run">
type Automation = Pick<ExpoAutomationController, "dispose" | "run">

const sessionInput = (context: AgentToolExecutionContext) => ({
  sessionId: context.session.id,
  worktreePath: context.session.repository.path
})

const ensureActive = (context: AgentToolExecutionContext): void => {
  if (context.signal.aborted) throw new Error("Expo preview action was cancelled.")
}

export const expoAgentTools = (
  controller: Preview
): readonly AgentToolDefinition[] => {
  const tool = (
    definition: Omit<AgentToolDefinition, "timeoutMs" | "outputBudget" | "cancellable">
  ): AgentToolDefinition => ({
    ...definition,
    timeoutMs: 30_000,
    outputBudget: 8_000,
    cancellable: true
  })
  const noInput = {
    type: "object",
    additionalProperties: false
  } satisfies AgentToolDefinition["inputSchema"]
  return [
    tool({
      id: "expo_preview_status",
      description: "Inspect Expo and iOS Simulator readiness and return the current preview status.",
      inputSchema: noInput,
      risk: "read",
      idempotency: "safe",
      execute: (_input, context) => {
        ensureActive(context)
        return controller.status(sessionInput(context))
      }
    }),
    tool({
      id: "expo_preview_open",
      description: "Start the current worktree's Expo app in iOS Simulator and mount it in Jingler's Expo tab.",
      inputSchema: noInput,
      risk: "execute",
      idempotency: "keyed",
      execute: (_input, context) => {
        ensureActive(context)
        return controller.start(sessionInput(context))
      }
    }),
    tool({
      id: "expo_preview_reload",
      description: "Request a reload of the current session's running Expo app.",
      inputSchema: noInput,
      risk: "execute",
      idempotency: "keyed",
      execute: (_input, context) => {
        ensureActive(context)
        return controller.reload(sessionInput(context))
      }
    }),
    tool({
      id: "expo_preview_stop",
      description: "Stop the Expo preview owned by the current session.",
      inputSchema: noInput,
      risk: "execute",
      idempotency: "keyed",
      execute: (_input, context) => {
        ensureActive(context)
        return controller.stop(sessionInput(context))
      }
    }),
    tool({
      id: "expo_preview_open_simulator",
      description: "Bring Apple's iOS Simulator application to the foreground.",
      inputSchema: noInput,
      risk: "execute",
      idempotency: "safe",
      execute: async (_input, context) => {
        ensureActive(context)
        await controller.openSimulator()
        return { opened: true }
      }
    })
  ]
}

const selectorSchema = {
  type: "object",
  properties: {
    identifier: { type: "string" },
    label: { type: "string" },
    text: { type: "string" }
  },
  additionalProperties: false
}

const decodeWaitInput = v.parser(v.object({
  selector: AutomationSelectorSchema,
  timeout: v.optional(AutomationTimeoutSchema)
}))
const decodeSelectorInput = v.parser(v.object({ selector: AutomationSelectorSchema }))
const decodeTypeInput = v.parser(v.object({
  selector: AutomationSelectorSchema,
  text: v.string(),
  replace: v.optional(v.boolean())
}))
const decodeSwipeInput = v.parser(v.object({
  direction: v.picklist(["up", "down", "left", "right"])
}))
const decodeButtonInput = v.parser(v.object({ button: v.literal("home") }))

export const expoAutomationTools = (
  controller: Preview,
  automation: AutomationRunner
): readonly AgentToolDefinition[] => {
  const run = async (
    action: AutomationAction,
    context: AgentToolExecutionContext
  ) => {
    ensureActive(context)
    const input = sessionInput(context)
    const status = await controller.status(input)
    if (
      (status.phase !== "starting" && status.phase !== "running") ||
      status.simulator?.state !== "Booted"
    ) {
      throw new Error("Start this session's Expo preview and wait for its iOS Simulator before automating it.")
    }
    return automation.run(
      action,
      input.worktreePath,
      status.simulator.udid,
      context.signal
    )
  }
  const definition = (
    value: Omit<AgentToolDefinition, "risk" | "idempotency" | "timeoutMs" | "outputBudget" | "cancellable">
  ): AgentToolDefinition => ({
    ...value,
    risk: "execute",
    idempotency: "keyed",
    timeoutMs: 180_000,
    outputBudget: 24_000,
    cancellable: true
  })
  return [
    definition({
      id: "expo_preview_describe_ui",
      description: "Return the current Expo app's bounded accessibility hierarchy from iOS Simulator.",
      inputSchema: { type: "object", additionalProperties: false },
      execute: (_value, context) => run({ kind: "describe" }, context)
    }),
    definition({
      id: "expo_preview_wait_for",
      description: "Wait for exactly one accessibility element selected by identifier, label, or visible text.",
      inputSchema: {
        type: "object",
        properties: {
          selector: selectorSchema,
          timeout: { type: "number", minimum: 0.1, maximum: 30 }
        },
        required: ["selector"],
        additionalProperties: false
      },
      execute: (value, context) => run(
        decodeAutomationAction({ kind: "wait", ...decodeWaitInput(value) }),
        context
      )
    }),
    definition({
      id: "expo_preview_tap",
      description: "Tap exactly one accessibility element selected by identifier, label, or visible text.",
      inputSchema: {
        type: "object",
        properties: { selector: selectorSchema },
        required: ["selector"],
        additionalProperties: false
      },
      execute: (value, context) => run(
        decodeAutomationAction({ kind: "tap", ...decodeSelectorInput(value) }),
        context
      )
    }),
    definition({
      id: "expo_preview_type",
      description: "Focus one semantic accessibility element and type text, optionally replacing its current value.",
      inputSchema: {
        type: "object",
        properties: {
          selector: selectorSchema,
          text: { type: "string" },
          replace: { type: "boolean" }
        },
        required: ["selector", "text"],
        additionalProperties: false
      },
      execute: (value, context) => run(
        decodeAutomationAction({ kind: "type", ...decodeTypeInput(value) }),
        context
      )
    }),
    definition({
      id: "expo_preview_swipe",
      description: "Swipe the Expo app up, down, left, or right in iOS Simulator.",
      inputSchema: {
        type: "object",
        properties: { direction: { type: "string", enum: ["up", "down", "left", "right"] } },
        required: ["direction"],
        additionalProperties: false
      },
      execute: (value, context) => run(
        decodeAutomationAction({ kind: "swipe", ...decodeSwipeInput(value) }),
        context
      )
    }),
    definition({
      id: "expo_preview_press_button",
      description: "Press a supported simulated device button. The first release supports Home.",
      inputSchema: {
        type: "object",
        properties: { button: { type: "string", enum: ["home"] } },
        required: ["button"],
        additionalProperties: false
      },
      execute: (value, context) => run(
        decodeAutomationAction({ kind: "button", ...decodeButtonInput(value) }),
        context
      )
    })
  ]
}

const trustedSessionInput = async (
  sessions: HostContext["sessions"],
  value: Parameters<typeof decodeExpoCommandInput>[0]
) => {
  const requested = decodeExpoCommandInput(value)
  const session = await sessions.get(requested.sessionId)
  if (!session?.worktreePath) {
    throw new Error("The Expo command requires an open session with a worktree.")
  }
  return { sessionId: session.id, worktreePath: session.worktreePath }
}

export const registerExpo = (
  ctx: Pick<HostContext, "agentTools" | "commands" | "subscriptions" | "log" | "sessions">,
  controller: Preview,
  automation?: Automation
): void => {
  const input = (value: Parameters<typeof decodeExpoCommandInput>[0]) =>
    trustedSessionInput(ctx.sessions, value)
  const commands = [
    ctx.commands.register("expo.inspect", async (value) => controller.inspect(await input(value))),
    ctx.commands.register("expo.start", async (value) => controller.start(await input(value))),
    ctx.commands.register("expo.status", async (value) => controller.status(await input(value))),
    ctx.commands.register("expo.frame", async (value) => controller.frame(await input(value))),
    ctx.commands.register("expo.reload", async (value) => controller.reload(await input(value))),
    ctx.commands.register("expo.stop", async (value) => controller.stop(await input(value))),
    ctx.commands.register("expo.open-simulator", () => controller.openSimulator())
  ]
  const tools = [...expoAgentTools(controller)]
  if (automation) tools.push(...expoAutomationTools(controller, automation))
  ctx.subscriptions.push(
    ctx.agentTools.registerToolset({ id: "expo.ios-preview", tools }),
    ...commands,
    {
      dispose: () => {
        Promise.all([controller.dispose(), automation?.dispose()]).catch((cause: unknown) => {
          ctx.log.warn(`Expo cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`)
        })
      }
    }
  )
  ctx.log.info("Expo iOS Preview ready")
}

export const activate: Activate = async (ctx) => {
  const derivedDataPath = await mkdtemp(join(tmpdir(), "jingler-expo-xctest-"))
  const automation = new ExpoAutomationController({
    projectPath: fileURLToPath(
      new URL(/* @vite-ignore */ AUTOMATION_PROJECT_PATH, import.meta.url)
    ),
    derivedDataPath,
    removeDerivedData: () => rm(derivedDataPath, { recursive: true, force: true })
  })
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

  registerExpo(ctx, controller, automation)
}
