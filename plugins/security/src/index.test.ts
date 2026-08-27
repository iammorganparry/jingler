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
    const exec = vi.fn(async () => ({ code: 0, stdout: '{"results":[{"path":"a.ts"}]}', stderr: "" }))
    const result = await securityTool({ exec } as Pick<HostContext, "exec">).execute({ action: "scan", scanner: "semgrep" }, context)
    expect(exec).toHaveBeenCalledWith("semgrep", ["scan", "--json", "--config", "auto", "."], expect.objectContaining({ cwd: "/repo" }))
    expect(result).toMatchObject({ scanner: "semgrep", findings: { results: [{ path: "a.ts" }] } })
  })

  it("redacts scanner match material and rejects invalid JSON", async () => {
    const exec = vi.fn(async () => ({ code: 1, stdout: '[{"Secret":"token","Match":"abc","message":"found abc","File":"a.env"}]', stderr: "" }))
    await expect(securityTool({ exec } as Pick<HostContext, "exec">).execute({ action: "scan", scanner: "gitleaks" }, context))
      .resolves.toMatchObject({ findings: [{ Secret: "[REDACTED]", Match: "[REDACTED]", message: "[REDACTED]", File: "a.env" }] })
    exec.mockResolvedValueOnce({ code: 0, stdout: "not json", stderr: "" })
    await expect(securityTool({ exec } as Pick<HostContext, "exec">).execute({ action: "scan", scanner: "trivy" }, context))
      .rejects.toThrow("invalid JSON")
  })

  it("never returns scanner stderr in an error", async () => {
    const exec = vi.fn(async () => ({ code: 2, stdout: "", stderr: "secret=do-not-leak" }))
    await expect(securityTool({ exec } as Pick<HostContext, "exec">).execute({ action: "scan", scanner: "semgrep" }, context))
      .rejects.not.toThrow("do-not-leak")
  })

  it("rejects oversized scanner output", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: "x".repeat(1_000_001), stderr: "" }))
    await expect(securityTool({ exec } as Pick<HostContext, "exec">).execute({ action: "scan", scanner: "trivy" }, context))
      .rejects.toThrow("exceeded 1 MB")
  })

  it("rejects unknown input before execution", async () => {
    const exec = vi.fn()
    await expect(securityTool({ exec } as Pick<HostContext, "exec">).execute({ action: "scan", scanner: "unknown" }, context))
      .rejects.toThrow("Unknown security scanner")
    expect(exec).not.toHaveBeenCalled()
  })
})
