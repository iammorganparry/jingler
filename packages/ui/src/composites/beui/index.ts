export * from "./messages.js"
export * from "./work.js"
export * from "./content.js"
export * from "./shell.js"

/** Official BeUI Agent registry slugs represented by this themed catalog. */
export const BEUI_AGENT_COMPONENTS = [
  "message-bubble", "message", "message-scroller", "prompt-input", "todo-list",
  "code-block", "approval-card", "file-diff", "tool-result", "streaming-response",
  "image-generation", "tool-approval", "citations", "agent-activity", "loading-states",
  "ai-sidebar", "chat-app"
] as const
