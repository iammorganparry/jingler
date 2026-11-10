import type { Session } from "@jingler/core"
import type { McpComposerMenuProps, McpConnectorRow } from "@jingler/ui"
import { rpc } from "./rpc-client.js"
import { publishSessionUpdate } from "./session-updates.js"
import { chatMcpKey, chatMcpRows, toggleChatMcp } from "./chat-mcp.js"

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
