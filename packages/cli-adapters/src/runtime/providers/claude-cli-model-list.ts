import { spawn } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { trackChild } from "../../child-registry.js"

/** One entry of the model list Claude Code reports on `initialize`. */
export interface ClaudeCliModel {
  /** What `--model` accepts: an alias (`sonnet`) or a full id (`claude-sonnet-5`). */
  readonly value: string
  readonly displayName: string
  /** The full id behind `value`; equal to `value` unless it is an alias. */
  readonly id: string
}

const ALIASES = new Set(["opus", "sonnet", "haiku", "fable"])

/** "Sonnet 5.5" → `claude-sonnet-5-5`. Null when the name carries no family + version. */
const idFromDisplayName = (displayName: string): string | null => {
  const match = /^([a-z]+)\s+(\d+(?:\.\d+)*)$/iu.exec(displayName.trim())
  return match === null ? null : `claude-${match[1]!.toLowerCase()}-${match[2]!.replaceAll(".", "-")}`
}

/** Parse the `models` array of Claude Code's `initialize` response. `default` is a UI pseudo-entry and is skipped. */
export const parseClaudeModelList = (raw: unknown): ReadonlyArray<ClaudeCliModel> => {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry): ReadonlyArray<ClaudeCliModel> => {
    const value = typeof entry?.value === "string" ? entry.value : null
    const displayName = typeof entry?.displayName === "string" ? entry.displayName : null
    if (value === null || displayName === null || value === "default") return []
    if (!ALIASES.has(value)) return [{ value, displayName, id: value }]
    const id = idFromDisplayName(displayName)
    return id === null ? [] : [{ value, displayName, id }]
  })
}

/** Cached per CLI version so child pi processes (which can't probe) read the same list synchronously. */
export const claudeModelCacheFile = (): string => join(homedir(), "jingler", "cache", "claude-models.json")

interface CacheFile {
  readonly version: string
  readonly models: ReadonlyArray<ClaudeCliModel>
}

const readCache = (): CacheFile | null => {
  try {
    const parsed = JSON.parse(readFileSync(claudeModelCacheFile(), "utf8")) as CacheFile
    return typeof parsed.version === "string" && Array.isArray(parsed.models) ? parsed : null
  } catch {
    return null
  }
}

/** The last probed list, or empty before the first probe. */
export const cachedClaudeModels = (): ReadonlyArray<ClaudeCliModel> => readCache()?.models ?? []

/** Ask a Claude Code binary for its model list via the stream-json `initialize` control request. */
export const probeClaudeModelList = (
  binary: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs = 20_000
): Promise<ReadonlyArray<ClaudeCliModel>> =>
  new Promise((resolve) => {
    const proc = trackChild(spawn(binary, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], {
      env: environment,
      stdio: ["pipe", "pipe", "ignore"]
    }))
    let buffer = ""
    let settled = false
    const finish = (models: ReadonlyArray<ClaudeCliModel>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      proc.kill()
      resolve(models)
    }
    const timer = setTimeout(() => finish([]), timeoutMs)
    proc.on("error", () => finish([]))
    proc.on("close", () => finish([]))
    proc.stdout?.setEncoding("utf8")
    proc.stdout?.on("data", (chunk: string) => {
      buffer += chunk
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as { type?: string; response?: { response?: { models?: unknown } } }
          if (message.type === "control_response") return finish(parseClaudeModelList(message.response?.response?.models))
        } catch {
          // Non-JSON noise on stdout; keep reading.
        }
      }
    })
    proc.stdin?.on("error", () => undefined)
    proc.stdin?.end(`${JSON.stringify({ type: "control_request", request_id: "jingler-models", request: { subtype: "initialize" } })}\n`)
  })

/**
 * The CLI's model list for `version`, probing only when the cache is for
 * another version. An empty probe never overwrites a good cache.
 */
export const claudeModelsForVersion = async (
  binary: string,
  version: string,
  environment: NodeJS.ProcessEnv
): Promise<ReadonlyArray<ClaudeCliModel>> => {
  const cached = readCache()
  if (cached?.version === version && cached.models.length > 0) return cached.models
  const models = await probeClaudeModelList(binary, environment)
  if (models.length === 0) return cached?.models ?? []
  try {
    mkdirSync(dirname(claudeModelCacheFile()), { recursive: true })
    writeFileSync(claudeModelCacheFile(), JSON.stringify({ version, models } satisfies CacheFile))
  } catch {
    // Best-effort: an unwritable cache only means the next call probes again.
  }
  return models
}
