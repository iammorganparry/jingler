import type { AgentToolExecutionContext, HostContext } from "@jingler/plugin-sdk/host"
import { describe, expect, it, vi } from "vitest"
import { securityTool } from "./index.js"

const context: AgentToolExecutionContext = {
  signal: new AbortController().signal,
  session: { id: "session", repository: { name: "repo", path: "/repo" } }
}

describe("security scan tool", () => {
  it("reports unavailable scanners without failing availability", async () => {
    const exec = vi.fn(async () => { throw new Error("ENOENT") })
    const result = await securityTool({ exec } as Pick<HostContext, "exec">).execute({ action: "availability" }, context)
    expect(result).toEqual({ available: [
      { scanner: "semgrep", available: false, version: null },
      { scanner: "trivy", available: false, version: null },
      { scanner: "gitleaks", available: false, version: null }
    ] })
  })

  it("fails clearly when the selected scanner is missing", async () => {
    const exec = vi.fn(async () => { throw new Error("ENOENT") })
    await expect(securityTool({ exec } as Pick<HostContext, "exec">).execute({ action: "scan", scanner: "semgrep" }, context))
      .rejects.toThrow("semgrep is unavailable")
  })

  it("uses the trusted session worktree and parses bounded JSON", async () => {
    const exec = vi.fn(async () => ({ code: 1, stdout: '{"results":[{"path":"a.ts"}]}', stderr: "" }))
    const result = await securityTool({ exec } as Pick<HostContext, "exec">).execute({ action: "scan", scanner: "semgrep" }, context)
    expect(exec).toHaveBeenCalledWith("semgrep", ["scan", "--json", "--config", "auto", "."], expect.objectContaining({ cwd: "/repo" }))
    expect(result).toMatchObject({ scanner: "semgrep", findings: { results: [{ path: "a.ts" }] } })
  })

  it("rejects unknown input before execution", async () => {
    const exec = vi.fn()
    await expect(securityTool({ exec } as Pick<HostContext, "exec">).execute({ action: "scan", scanner: "unknown" }, context))
      .rejects.toThrow("Unknown security scanner")
    expect(exec).not.toHaveBeenCalled()
  })
})
