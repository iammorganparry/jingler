import type { Activate, AgentToolDefinition, HostContext } from "@jingler/plugin-sdk/host"

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
    case "trivy": return ["fs", "--format", "json", "--scanners", "vuln,secret,misconfig", "."]
    case "gitleaks": return ["detect", "--no-git", "--report-format", "json", "--report-path", "-"]
  }
}

const boundedJson = (stdout: string): unknown => {
  if (stdout.length > 1_000_000) throw new Error("Scanner output exceeded 1 MB; narrow the scan")
  try {
    return JSON.parse(stdout)
  } catch {
    return { output: stdout.slice(0, 32_000) }
  }
}

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
  cancellable: true,
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
    let result
    try {
      result = await ctx.exec(scanner, argsFor(scanner), {
        cwd: context.session.repository.path,
        timeoutMs: 120_000
      })
    } catch {
      throw new Error(`${scanner} is unavailable; install it or choose another scanner`)
    }
    if (result.code !== 0 && result.stdout.trim().length === 0) {
      throw new Error(`${scanner} failed: ${result.stderr.trim().slice(0, 1_000) || `exit ${result.code}`}`)
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
