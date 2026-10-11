/**
 * Which MCP "needs sign-in" recovery cards the operator has dismissed.
 *
 * Persisted in localStorage (same pattern as `viewed-store.ts`) so a dismissal
 * survives a reload. The key is `<server>:<authKind>`, so changing a server's
 * auth kind shows the card again, and `clearMcpRecoveryDismissal` is called once
 * the server is healthy again so a *new* failure is never hidden by an old
 * dismissal.
 */
const STORAGE_KEY = "sb.mcp.recovery.dismissed"

export const mcpRecoveryKey = (server: { readonly name: string; readonly authKind: string }): string =>
  `${server.name}:${server.authKind}`

const read = (): ReadonlySet<string> => {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [])
  } catch {
    return new Set()
  }
}

const write = (keys: ReadonlySet<string>): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...keys]))
  } catch {
    // Storage unavailable or full: the card simply returns next time.
  }
}

export const isMcpRecoveryDismissed = (key: string): boolean => read().has(key)

export const dismissMcpRecovery = (key: string): void => write(new Set(read()).add(key))

export const clearMcpRecoveryDismissal = (key: string): void => {
  const keys = new Set(read())
  if (keys.delete(key)) write(keys)
}
