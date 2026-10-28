import { describe, expect, it } from "vitest"
import type { McpServer } from "@jingler/core"
import { mcpToolAuthServer } from "./mcp-tool-auth.js"

const server = (over: Partial<McpServer> = {}): McpServer => ({
  name: "runpod", displayName: "RunPod", iconUrl: null, authKind: "oauth", authState: "needs-auth",
  transport: "http", scope: "user", target: "https://x", envKeys: [], headerKeys: [], enabled: true, ...over
})
const tool = (over: Partial<{ name: string; status: string; output: string }> = {}) =>
  ({ name: "mcp__runpod__list_pods", status: "error", ...over })

describe("mcpToolAuthServer", () => {
  it("matches a failed tool of a needs-auth server", () => {
    expect(mcpToolAuthServer(tool(), [server()])?.name).toBe("runpod")
  })
  it("matches an auth-looking output when the server looks ready", () => {
    expect(mcpToolAuthServer(tool({ output: "HTTP 401 Unauthorized" }), [server({ authState: "ready" })])).not.toBeNull()
  })
  it("ignores other failures, successes, non-MCP tools and unmanaged servers", () => {
    const ready = [server({ authState: "ready" })]
    expect(mcpToolAuthServer(tool({ output: "boom" }), ready)).toBeNull()
    expect(mcpToolAuthServer(tool({ status: "success" }), [server()])).toBeNull()
    expect(mcpToolAuthServer(tool({ name: "bash" }), [server()])).toBeNull()
    expect(mcpToolAuthServer(tool(), [server({ name: "other" })])).toBeNull()
    expect(mcpToolAuthServer(tool(), [server({ authKind: "none" })])).toBeNull()
  })
})
