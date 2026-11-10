import type { McpConnectorRow } from "@jingler/ui"

const CLAUDE_AI_ROW = "claude.ai:"

/** The name the runtime filters on: an mcp.json name, or `claude.ai <Name>` for a native connector. */
export const chatMcpKey = (row: McpConnectorRow): string =>
  row.id.startsWith(CLAUDE_AI_ROW) ? row.id.slice(CLAUDE_AI_ROW.length) : row.id

/** Rows as this chat sees them: globally enabled and not turned off for the chat. */
export const chatMcpRows = (
  rows: ReadonlyArray<McpConnectorRow>,
  disabled: ReadonlyArray<string>
): ReadonlyArray<McpConnectorRow> =>
  rows.map((row) => ({ ...row, enabled: row.enabled && !disabled.includes(chatMcpKey(row)) }))

export const toggleChatMcp = (
  disabled: ReadonlyArray<string>,
  key: string,
  enabled: boolean
): ReadonlyArray<string> => enabled ? disabled.filter((name) => name !== key) : [...new Set([...disabled, key])]
