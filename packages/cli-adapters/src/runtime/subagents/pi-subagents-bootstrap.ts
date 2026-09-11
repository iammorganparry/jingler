import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import {
  JINGLER_SUBAGENT_NAMES,
  type JinglerSubagentName,
  type SubagentModelAssignments
} from "@jingler/core"
import { Data, Effect, Schema } from "effect"
import {
  defaultPiChildLauncherConfig,
  preparePiChildLauncher
} from "./pi-child-launcher.js"
import { PONYTAIL_EXTENSION_PATH } from "../resources/ponytail-resources.js"

const require = createRequire(import.meta.url)
export const PI_SUBAGENTS_EXTENSION_PATH = require.resolve("pi-subagents")
const PI_SUBAGENTS_AGENT_DIR = join(
  dirname(PI_SUBAGENTS_EXTENSION_PATH),
  "agents"
)
const BUILTIN_AGENTS = JINGLER_SUBAGENT_NAMES.filter(
  (agent) => agent !== "fanout"
)
export type PiSubagentProfileTools = Partial<
  Record<JinglerSubagentName, ReadonlyArray<string>>
>

const profileTools = (
  brokered: ReadonlyArray<string> = [],
  fanout = false
): string => [...new Set([
  ...(fanout ? ["subagent"] : []),
  "contact_supervisor",
  ...brokered
])].join(", ")

const PiSubagentConfig = Schema.Struct({
  artifactDir: Schema.Literal("session"),
  asyncByDefault: Schema.Boolean,
  asyncWidget: Schema.Boolean,
  fleetView: Schema.Boolean,
  inlineToolDisplay: Schema.Literal("summary"),
  globalConcurrencyLimit: Schema.Number,
  maxActiveAsyncRunsPerSession: Schema.Number,
  maxSubagentSpawnsPerRun: Schema.Number,
  maxSubagentSpawnsPerSession: Schema.Number,
  missions: Schema.Struct({ enabled: Schema.Boolean }),
  toolDescriptionMode: Schema.Literal("compact")
})

const CONFIG = {
  artifactDir: "session",
  // Foreground by default: a delegated child's report lands in the PARENT
  // transcript when the tool call settles, where the operator can read it.
  // Async detach hid the output entirely unless the model later polled — a
  // running card with no transcript and no result. Long multi-child
  // orchestration opts back in per call with `async: true` + subagent_wait.
  asyncByDefault: false,
  asyncWidget: false,
  fleetView: false,
  inlineToolDisplay: "summary",
  globalConcurrencyLimit: 4,
  maxActiveAsyncRunsPerSession: 4,
  maxSubagentSpawnsPerRun: 8,
  maxSubagentSpawnsPerSession: 16,
  missions: { enabled: false },
  toolDescriptionMode: "compact"
} as const

export class PiSubagentsBootstrapError extends Data.TaggedError(
  "PiSubagentsBootstrapError"
)<{
  readonly message: string
  readonly cause?: unknown
}> {}

const configPath = (agentDir: string): string =>
  join(agentDir, "extensions", "subagent", "config.json")

const sameConfig = async (path: string): Promise<boolean> => {
  try {
    const parsed = Schema.decodeUnknownSync(Schema.parseJson(PiSubagentConfig))(
      await readFile(path, "utf8")
    )
    return JSON.stringify(parsed) === JSON.stringify(CONFIG)
  } catch {
    return false
  }
}

const writeConfig = async (path: string): Promise<void> => {
  if (await sameConfig(path)) return
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.next`
  try {
    await writeFile(temporary, `${JSON.stringify(CONFIG, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

const rewriteAgentProfile = (
  source: string,
  childToolsPath: string,
  claudeProviderPath: string,
  tools: string,
  model?: string
): string => source
  .replace(/^tools:.*$/m, `tools: ${tools}`)
  .replace(/^inheritProjectContext:.*$/m, "inheritProjectContext: false")
  .replace(
    /^---\n/u,
    `---\nextensions: ${childToolsPath}, ${claudeProviderPath}, ${PONYTAIL_EXTENSION_PATH}\n${model ? `model: ${JSON.stringify(model)}\n` : ""}`
  )

/**
 * Shadow vendor profiles with Jingler-managed definitions. Brokered tools are
 * registered by the explicit child extension; their names must also be in Pi's
 * hard tool allowlist. The one fanout profile opts into nested spawning.
 */
export const materializePiSubagentProfiles = async (
  agentDir: string,
  childToolsPath: string,
  claudeProviderPath: string,
  models: SubagentModelAssignments = {},
  tools: PiSubagentProfileTools = {}
): Promise<void> => {
  const target = join(agentDir, "agents")
  await mkdir(target, { recursive: true, mode: 0o700 })
  await Promise.all(BUILTIN_AGENTS.map(async (agent) => {
    const source = await readFile(join(PI_SUBAGENTS_AGENT_DIR, `${agent}.md`), "utf8")
    await writeFile(
      join(target, `${agent}.md`),
      rewriteAgentProfile(
        source,
        childToolsPath,
        claudeProviderPath,
        profileTools(tools[agent]),
        models[agent]
      ),
      { encoding: "utf8", mode: 0o600 }
    )
  }))
  const delegate = await readFile(
    join(PI_SUBAGENTS_AGENT_DIR, "delegate.md"),
    "utf8"
  )
  const fanout = rewriteAgentProfile(
    delegate
      .replace(/^name: delegate$/m, "name: fanout")
      .replace(
        /^description:.*$/m,
        "description: Explicit fan-out coordinator allowed to spawn bounded children"
      )
      .replace(
        "You are a delegated agent.",
        "You are a fan-out coordinator. Delegate bounded independent tasks, coordinate results, and do not edit the workspace directly."
      ),
    childToolsPath,
    claudeProviderPath,
    profileTools(tools.fanout, true),
    models.fanout
  )
  await writeFile(join(target, "fanout.md"), fanout, {
    encoding: "utf8",
    mode: 0o600
  })
}

/**
 * Prepare pi-subagents for Jingler's embedded host.
 *
 * The extension resolves configuration dynamically from PI_CODING_AGENT_DIR,
 * including after its factory has registered event handlers. Jingler therefore
 * pins the process-wide value to its one app-owned agent directory before any
 * embedded session loads. Every desktop session shares that directory; a second
 * distinct root in one process would make extension lifecycle artifacts and
 * controls ambiguous, so it fails closed.
 */
export const preparePiSubagentsRuntime = (
  agentDir: string,
  models: SubagentModelAssignments = {},
  tools: PiSubagentProfileTools = {}
): Effect.Effect<void, PiSubagentsBootstrapError> =>
  Effect.tryPromise({
    try: async () => {
      const expected = resolve(agentDir)
      const configured = process.env.PI_CODING_AGENT_DIR
      if (configured !== undefined && resolve(configured) !== expected) {
        throw new Error(
          `PI_CODING_AGENT_DIR already targets a different runtime root: ${configured}`
        )
      }
      process.env.PI_CODING_AGENT_DIR = expected
      await writeConfig(configPath(expected))
      const launcher = defaultPiChildLauncherConfig(expected)
      await materializePiSubagentProfiles(
        expected,
        launcher.childToolsPath,
        launcher.claudeProviderPath,
        models,
        tools
      )
      await Effect.runPromise(preparePiChildLauncher(launcher))
    },
    catch: (cause) =>
      new PiSubagentsBootstrapError({
        message: "Could not prepare the embedded pi-subagents runtime",
        cause
      })
  })
