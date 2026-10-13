import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { ChevronDown, MessagesSquare, MousePointer2, Plus, X } from "lucide-react"
import { Button } from "../components/button.js"
import { StatusDot } from "../components/status-dot.js"
import { cn } from "../lib/cn.js"

export interface ChatLaneHeaderChat {
  readonly id: string
  readonly title: string
  readonly running?: boolean
}

export interface ChatLaneHeaderProps {
  /** Open chats in this session. */
  readonly chats: ReadonlyArray<ChatLaneHeaderChat>
  /** Currently active chat ID. */
  readonly activeChatId: string
  /** Switch to a different chat thread. */
  readonly onSelectChat: (id: string) => void
  /** Create a new chat thread. */
  readonly onCreateChat: () => void
  /** Close a chat tab. Omit to hide the per-chat close items. */
  readonly onCloseChat?: (id: string) => void
  /** Whether the file browser follows this chat's agent edits. */
  readonly followAgent?: boolean
  /** Toggle the shared agent-follow mode. */
  readonly onToggleFollowAgent?: (enabled: boolean) => void
}

/**
 * Chat lane header: thread switcher dropdown, new chat, subagent chip slot,
 * and follow-agent toggle.
 *
 * Replaces the chat tab strip in redesign 4.3. The header sits above the
 * transcript, consolidating thread selection into a dropdown rather than
 * horizontal pills. The subagent chip slot is reserved for issue #8.1.
 */
export function ChatLaneHeader({
  chats,
  activeChatId,
  onSelectChat,
  onCreateChat,
  onCloseChat,
  followAgent = false,
  onToggleFollowAgent
}: ChatLaneHeaderProps) {
  const activeChat = chats.find((chat) => chat.id === activeChatId)
  const activeTitle = activeChat?.title ?? "Chat"

  return (
    <div
      data-testid="chat-lane-header"
      className="flex h-10 flex-none items-center gap-2 border-b border-hairline bg-sunken/70 px-3"
    >
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button
            variant="ghost"
            size="sm"
            data-testid="thread-switcher"
            aria-label="Switch chat thread"
            className="min-w-0 flex-1 justify-start gap-2 px-2 text-xs"
          >
            <MessagesSquare className="size-3.5 flex-none text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-left font-medium text-text-bright">
              {activeTitle}
            </span>
            {activeChat?.running && (
              <StatusDot tone="bg-muted-foreground" pulse size={7} />
            )}
            <ChevronDown className="size-3 flex-none text-dim" />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            sideOffset={6}
            collisionPadding={8}
            className="z-50 flex min-w-[220px] max-w-[calc(100vw-1rem)] flex-col gap-0.5 rounded-lg border border-line bg-sunken p-1.5 shadow-2xl"
          >
            {chats.map((chat) => {
              const active = chat.id === activeChatId
              return (
                <div key={chat.id} className="flex items-center gap-0.5">
                  <DropdownMenu.Item
                    data-testid={`chat-option-${chat.id}`}
                    onSelect={() => onSelectChat(chat.id)}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-[12.5px] outline-none data-[highlighted]:bg-surface data-[highlighted]:text-text-bright"
                  >
                    <StatusDot
                      tone={chat.running ? "bg-muted-foreground" : active ? "bg-text-bright" : "bg-dim"}
                      pulse={chat.running ?? false}
                      size={7}
                    />
                    <span className={cn("min-w-0 flex-1 truncate", active ? "text-text-bright" : "text-text-body")}>
                      {chat.title}
                    </span>
                  </DropdownMenu.Item>
                  {onCloseChat && (
                    <DropdownMenu.Item
                      data-testid={`chat-close-${chat.id}`}
                      aria-label={`Close ${chat.title}`}
                      onSelect={() => onCloseChat(chat.id)}
                      className="flex flex-none cursor-pointer items-center rounded-md p-2 text-dim outline-none data-[highlighted]:bg-surface data-[highlighted]:text-text-bright"
                    >
                      <X className="size-3" />
                    </DropdownMenu.Item>
                  )}
                </div>
              )
            })}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <Button
        variant="ghost"
        size="sm"
        data-testid="new-chat-button"
        aria-label="New chat"
        title="New chat"
        onClick={onCreateChat}
        className="flex-none px-1.5"
      >
        <Plus className="size-3.5" />
      </Button>

      {/* Subagent chip slot reserved for issue #8.1 */}
      <div data-testid="subagent-slot" className="flex-none" />

      {onToggleFollowAgent && (
        <Button
          variant="ghost"
          size="sm"
          data-testid="follow-agent-toggle"
          aria-label="Follow agent"
          aria-pressed={followAgent}
          title={
            followAgent
              ? "Stop following files edited by this chat's agent"
              : "Follow files edited by this chat's agent"
          }
          onClick={() => onToggleFollowAgent(!followAgent)}
          className={cn(
            "flex-none px-1.5",
            followAgent && "bg-surface text-text-bright"
          )}
        >
          <MousePointer2 className="size-3.5" />
        </Button>
      )}
    </div>
  )
}
