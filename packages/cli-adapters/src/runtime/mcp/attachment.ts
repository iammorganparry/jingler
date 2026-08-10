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
