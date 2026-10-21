import type { McpServer } from "@jingler/core"

const AUTH_OUTPUT = /\b401\b|unauthori[sz]ed|needs[- ]auth/iu

/**
 * The MCP server a failed tool call needs the operator to sign in to, or null
 * for every other failure. Tool ids are `mcp__<server>__<tool>`; the server's
 * own auth state wins, with the tool's output as a fallback signal.
 */
export const mcpToolAuthServer = (
  tool: { readonly name: string; readonly status: string; readonly output?: string },
  servers: ReadonlyArray<McpServer>
): McpServer | null => {
  if (tool.status !== "error") return null
  const parts = tool.name.split("__")
  if (parts[0] !== "mcp" || parts.length < 3) return null
  const server = servers.find((s) => s.name === parts[1] && s.enabled && s.authKind !== "none")
  if (server === undefined) return null
  return server.authState === "needs-auth" || AUTH_OUTPUT.test(tool.output ?? "") ? server : null
}
