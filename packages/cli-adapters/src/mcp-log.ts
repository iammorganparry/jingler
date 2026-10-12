import type { Stream } from "node:stream"

/**
 * Where MCP server logs live: nowhere on disk. The probe used to discard a stdio
 * server's stderr; it now keeps the last `MAX_LOG_LINES` lines per server in this
 * in-memory ring, replaced on every probe. Remote (http/sse) servers have no stderr.
 */
export const MAX_LOG_LINES = 500
export const DEFAULT_LOG_TAIL = 200
/** A server dumping one giant line must not balloon memory or the UI. */
const MAX_LINE = 2000

const logs = new Map<string, Array<string>>()

const pushLine = (buffer: Array<string>, line: string): void => {
  buffer.push(line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line)
  if (buffer.length > MAX_LOG_LINES) buffer.shift()
}

/** Start a fresh tail for `name` from a child's stderr stream; a new probe replaces the old tail. */
export const captureMcpStderr = (name: string, stderr: Stream | null): void => {
  const buffer: Array<string> = []
  logs.set(name, buffer)
  if (stderr === null) return
  let partial = ""
  stderr.on("data", (chunk: Buffer | string) => {
    const parts = (partial + chunk.toString()).split(/\r?\n/u)
    partial = parts.pop() ?? ""
    for (const line of parts) pushLine(buffer, line)
  })
  stderr.on("end", () => {
    if (partial.length > 0) pushLine(buffer, partial)
    partial = ""
  })
}

/** The last `lines` lines for `name` (clamped to 1..MAX_LOG_LINES); empty if unknown. */
export const mcpLogTail = (name: string, lines: number = DEFAULT_LOG_TAIL): ReadonlyArray<string> => {
  const count = Math.min(Math.max(Math.trunc(lines), 1), MAX_LOG_LINES)
  return (logs.get(name) ?? []).slice(-count)
}
