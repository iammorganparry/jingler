/** Secret-bearing, main-process-only MCP attachment resolved for one pi run. */
export interface RuntimeMcpServer {
  readonly name: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly headerEnvironment?: Readonly<Record<string, string>>
}
