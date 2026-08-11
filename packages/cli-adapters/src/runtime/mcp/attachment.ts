import type { McpServer, McpTransport } from "@jingler/core"

/** Secret-bearing, main-process-only remote MCP attachment resolved for one pi run. */
export interface RuntimeRemoteMcpServer {
  readonly name: string
  readonly transport?: "http" | "sse"
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly headerEnvironment?: Readonly<Record<string, string>>
}

/** Secret-bearing stdio attachment. Its executable and environment are target-local. */
export interface RuntimeStdioMcpServer {
  readonly name: string
  readonly transport: "stdio"
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly cwd?: string
}

export type RuntimeMcpServer = RuntimeRemoteMcpServer | RuntimeStdioMcpServer

/** Everything needed to connect to an MCP server. Never crosses the main-process boundary. */
export interface McpLaunch {
  readonly transport: McpTransport
  readonly command?: string
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly url?: string
  readonly headers: Readonly<Record<string, string>>
  readonly headerEnvironment?: Readonly<Record<string, string>>
}

/** Redacted metadata paired with its secret-bearing launch configuration. */
export interface ParsedMcpServer {
  readonly server: McpServer
  readonly launch: McpLaunch
}

export const remoteMcpServer = (
  entry: ParsedMcpServer | null | undefined
): RuntimeRemoteMcpServer | null =>
  entry?.launch.url === undefined
    ? null
    : {
        name: entry.server.name,
        url: entry.launch.url,
        headers: entry.launch.headers,
        ...(entry.launch.headerEnvironment === undefined
          ? {}
          : { headerEnvironment: entry.launch.headerEnvironment })
      }

/** Preserve priority order and prevent lower-priority servers from shadowing names. */
export const composeRemoteMcpServers = (
  ...entries: ReadonlyArray<RuntimeRemoteMcpServer | null>
): ReadonlyArray<RuntimeRemoteMcpServer> => {
  const names = new Set<string>()
  const attachments: RuntimeRemoteMcpServer[] = []
  for (const entry of entries) {
    if (entry === null || names.has(entry.name)) continue
    names.add(entry.name)
    attachments.push(entry)
  }
  return attachments
}
