import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  nativeCliEndpointId,
  ProviderId,
  ProviderModelId,
  type AgentEndpointCatalogEntry,
  type AgentEndpointStatus
} from "@jingler/core"
import { nativeCliEnvironment } from "./native-cli-environment.js"

const execFileAsync = promisify(execFile)

interface ClaudeAuthStatus {
  readonly loggedIn?: boolean
  readonly authMethod?: string
  readonly apiProvider?: string
}

export interface ClaudeEndpointProbeOptions {
  readonly binary?: string
  readonly environment?: NodeJS.ProcessEnv
  readonly targetId?: string
}

const run = async (
  binary: string,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv
): Promise<string> => {
  const result = await execFileAsync(binary, [...args], {
    env: environment,
    timeout: 5_000,
    maxBuffer: 256_000
  })
  return result.stdout.trim()
}

const semanticVersion = /(\d+)\.(\d+)\.(\d+)/u
const versionAtLeast = (raw: string, minimum: readonly [number, number, number]): boolean => {
  const match = semanticVersion.exec(raw)
  if (match === null) return false
  const value = [Number(match[1]), Number(match[2]), Number(match[3])] as const
  for (let index = 0; index < value.length; index += 1) {
    if (value[index]! !== minimum[index]!) return value[index]! > minimum[index]!
  }
  return true
}

const models = (version: string | null) => {
  const providerId = ProviderId.make("anthropic")
  const model = (id: string, label: string, contextWindow: number) => ({
    providerId,
    id: ProviderModelId.make(`anthropic/${id}`),
    label,
    capabilities: {
      contextWindow,
      reasoning: ["low", "medium", "high", "max"] as const,
      reasoningCanDisable: false,
      reasoningDefault: "medium" as const,
      vision: true,
      nativeWebSearch: false
    },
    verification: "unverified" as const,
    status: "ready" as const,
    selectable: true,
    certificationKey: null
  })
  return [
    model("opus", "Opus (latest)", 1_000_000),
    ...(version !== null && versionAtLeast(version, [2, 1, 282])
      ? [model("claude-opus-5-5", "Claude Opus 5.5", 1_000_000)]
      : []),
    model("sonnet", "Sonnet (latest)", 1_000_000),
    model("haiku", "Haiku (latest)", 200_000)
  ]
}

const probeAuthentication = async (
  binary: string,
  environment: NodeJS.ProcessEnv
): Promise<AgentEndpointStatus> => {
  try {
    const auth = JSON.parse(await run(binary, ["auth", "status"], environment)) as ClaudeAuthStatus
    return auth.loggedIn === true &&
      auth.authMethod === "claude.ai" &&
      auth.apiProvider === "firstParty"
      ? "ready"
      : "signed-out"
  } catch (cause) {
    return cause instanceof Error && "code" in cause && cause.code === 1
      ? "signed-out"
      : "error"
  }
}

export const probeClaudeEndpoint = async (
  options: ClaudeEndpointProbeOptions = {}
): Promise<AgentEndpointCatalogEntry> => {
  const binary = options.binary ?? process.env.JINGLER_CLAUDE_BINARY ?? "claude"
  const environment = nativeCliEnvironment(options.environment ?? process.env)
  const targetId = options.targetId ?? "desktop"
  let version: string | null = null
  let status: AgentEndpointStatus = "error"
  try {
    version = await run(binary, ["--version"], environment)
  } catch (cause) {
    const code = cause instanceof Error && "code" in cause
      ? (cause as NodeJS.ErrnoException).code
      : undefined
    status = code === "ENOENT" ? "missing" : "error"
  }
  if (version !== null && !versionAtLeast(version, [2, 1, 282])) {
    status = "unsupported"
  } else if (version !== null) {
    status = await probeAuthentication(binary, environment)
  }
  return {
    endpoint: {
      id: nativeCliEndpointId(targetId, "claude"),
      runtimeId: "claude",
      targetId,
      label: "Claude Code",
      status,
      version,
      ...(version === null ? {} : { protocolVersion: version }),
      features: {
        steer: "none",
        planReview: false,
        subagentFleet: false,
        backgroundTasks: false
      }
    },
    models: models(version).map((model) => ({
      ...model,
      status: status === "ready" ? "ready" as const : "unavailable" as const,
      selectable: status === "ready"
    }))
  }
}
