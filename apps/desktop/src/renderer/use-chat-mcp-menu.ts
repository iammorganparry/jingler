import type { Session } from "@jingler/core"
import type { McpComposerMenuProps, McpConnectorRow } from "@jingler/ui"
import { rpc } from "./rpc-client.js"
import { publishSessionUpdate } from "./session-updates.js"

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

type MenuProps = Omit<McpComposerMenuProps, "embedded" | "reconnectLimit">

/** Composer `+ › MCP` (board 25e) for one chat. Local sessions only: remote devices have their own MCP config. */
export function useChatMcpMenu(
  session: Session,
  chat: Session["chats"][number],
  rows: ReadonlyArray<McpConnectorRow> | undefined,
  authorize: ((name: string) => Promise<void>) | undefined,
  openSettings: (() => void) | undefined
): MenuProps | undefined {
  if (rows === undefined || session.environmentId !== undefined) return undefined
  const disabled = chat.disabledMcp ?? []
  return {
    rows: chatMcpRows(rows, disabled),
    onToggle: (row, enabled) => {
      void rpc.agentSetChatMcp(session.id, chat.id, toggleChatMcp(disabled, chatMcpKey(row), enabled))
        .then(() => rpc.sessionsGet(session.id))
        .then(publishSessionUpdate)
    },
    onReconnect: (row) => {
      if (row.source === "claude.ai") void window.jingler.openExternal("https://claude.ai/customize/connectors")
      else if (authorize !== undefined) void authorize(row.id).catch(() => openSettings?.())
      else openSettings?.()
    },
    onBrowse: () => openSettings?.(),
    onManage: () => openSettings?.()
  }
}
