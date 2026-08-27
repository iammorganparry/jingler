import type { Activate, AgentToolDefinition, ExecResult, HostContext } from "@jingler/plugin-sdk/host"

export const SCANNERS = ["semgrep", "trivy", "gitleaks"] as const
export type Scanner = typeof SCANNERS[number]

interface SecurityInput {
  readonly action: "availability" | "scan"
  readonly scanner?: Scanner
}

const decode = (value: unknown): SecurityInput => {
  if (typeof value !== "object" || value === null) throw new Error("Security input must be an object")
  const input = value as Record<string, unknown>
  if (input.action !== "availability" && input.action !== "scan") throw new Error("Unknown security action")
  if (input.scanner !== undefined && !SCANNERS.includes(input.scanner as Scanner)) throw new Error("Unknown security scanner")
  if (input.action === "scan" && input.scanner === undefined) throw new Error("scan requires scanner")
  return { action: input.action, ...(input.scanner ? { scanner: input.scanner as Scanner } : {}) }
}

const argsFor = (scanner: Scanner): readonly string[] => {
  switch (scanner) {
    case "semgrep": return ["scan", "--json", "--config", "auto", "."]
    case "trivy": return ["fs", "--format", "json", "--scanners", "vuln,secret,misconfig", "--redact", "."]
    case "gitleaks": return ["detect", "--no-git", "--redact", "--report-format", "json", "--report-path", "-"]
  }
}

const SAFE_TEXT_FIELD = /^(?:path|file|filename|ruleid|check_id|id|severity|category|type|scanner|package|name|version|installedversion|fixedversion)$/iu
const sanitize = (value: unknown, key = ""): unknown => {
  if (typeof value === "string") return SAFE_TEXT_FIELD.test(key) ? value : "[REDACTED]"
  if (Array.isArray(value)) return value.map((item) => sanitize(item))
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitize(item, name)]))
  }
  return value
}

const boundedJson = (stdout: string): unknown => {
  if (stdout.length > 1_000_000) throw new Error("Scanner output exceeded 1 MB; narrow the scan")
  try {
    return sanitize(JSON.parse(stdout))
  } catch (cause) {
    if (cause instanceof SyntaxError) throw new Error("Scanner returned invalid JSON")
    throw cause
  }
}

const validExit = (scanner: Scanner, code: number): boolean => code === 0 || (scanner === "gitleaks" && code === 1)

export const securityTool = (ctx: Pick<HostContext, "exec">): AgentToolDefinition => ({
  id: "security_scan",
  description: "Check installed security scanners or run one explicitly. Use for auth, secrets, dependency, permission, or security-sensitive changes; do not run for routine edits.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["availability", "scan"] },
      scanner: { type: "string", enum: SCANNERS }
    },
    required: ["action"],
    additionalProperties: false
  },
  risk: "execute",
  idempotency: "safe",
  timeoutMs: 120_000,
  outputBudget: 32_000,
  cancellable: false,
  execute: async (value, context) => {
    const input = decode(value)
    if (input.action === "availability") {
      const available = await Promise.all(SCANNERS.map(async (scanner) => {
        try {
          const result = await ctx.exec(scanner, ["--version"], { cwd: context.session.repository.path, timeoutMs: 5_000 })
          return { scanner, available: result.code === 0, version: result.code === 0 ? result.stdout.trim().slice(0, 200) : null }
        } catch {
          return { scanner, available: false, version: null }
        }
      }))
      return { available }
    }
    const scanner = input.scanner!
    let result: ExecResult
    try {
      result = await ctx.exec(scanner, argsFor(scanner), {
        cwd: context.session.repository.path,
        timeoutMs: 120_000
      })
    } catch {
      throw new Error(`${scanner} is unavailable; install it or choose another scanner`)
    }
    if (!validExit(scanner, result.code)) {
      throw new Error(`${scanner} failed with exit ${result.code}; inspect the scanner locally for redacted diagnostics`)
    }
    return { scanner, exitCode: result.code, findings: boundedJson(result.stdout) }
  }
})

export const activate: Activate = (ctx) => {
  ctx.subscriptions.push(ctx.agentTools.registerToolset({
    id: "security.scan",
    tools: [securityTool(ctx)]
  }))
  ctx.log.info("Security scanner toolset ready")
}
