/**
 * Canonical display names for every tool id a transcript can carry.
 *
 * The same operation arrives under different ids depending on the runtime
 * route: Jingler-managed tools (`workspace_read_file`, `command_execute`),
 * pi's native tools (`read`, `bash`), and historical transcripts. The
 * transcript styles by NAME (see PATH_TOOLS in message-turn), so all of them
 * normalise to one design here. Unknown ids — MCP tools, plugin tools —
 * render under their own name.
 */
const CANONICAL_TOOL_NAMES: Readonly<Record<string, string>> = {
  // Files
  workspace_read_file: "Read",
  read: "Read",
  workspace_write: "Write",
  write: "Write",
  workspace_edit: "Edit",
  edit: "Edit",
  workspace_delete: "Delete",
  workspace_rename: "Rename",
  // Discovery
  workspace_list_files: "List",
  ls: "List",
  grep: "Grep",
  find: "Find",
  // Execution
  command_execute: "Bash",
  bash: "Bash",
  debug: "Debug",
  // Native pi-subagents fleet tools
  subagent: "Subagent",
  subagent_wait: "Wait for subagents",
  // Jingler agent surface
  jingler_ask_question: "Ask",
  jingler_save_draft_plan: "Draft plan",
  jingler_submit_plan: "Submit plan",
  jingler_list_resources: "Resources",
  jingler_load_resource: "Resource",
  jingler_set_work_mode: "Work mode",
  conversation_search: "Search chats",
  conversation_read: "Read chat",
  // The in-app browser (the jingler-browser MCP server)
  "mcp__jingler-browser__navigate": "Navigate",
  "mcp__jingler-browser__screenshot": "Screenshot",
  "mcp__jingler-browser__click": "Click",
  "mcp__jingler-browser__type": "Type",
  "mcp__jingler-browser__read_text": "Read page",
  "mcp__jingler-browser__evaluate": "Evaluate",
  "mcp__jingler-browser__wait_for_selector": "Wait for",
  "mcp__jingler-browser__hover": "Hover",
  "mcp__jingler-browser__press_key": "Press key",
  "mcp__jingler-browser__scroll": "Scroll",
  "mcp__jingler-browser__select_option": "Select",
  "mcp__jingler-browser__snapshot": "Snapshot",
  "mcp__jingler-browser__get_url": "Page URL",
  "mcp__jingler-browser__back": "Back",
  "mcp__jingler-browser__reload": "Reload",
  "mcp__jingler-browser__network_requests": "Network",
  "mcp__jingler-browser__network_request_detail": "Request",
  "mcp__jingler-browser__console_logs": "Console"
}

const BROWSER_TOOL_PREFIX = "mcp__jingler-browser__"

/** The bare browser tool (`click`, `network_requests`…) for a `jingler-browser` id, else null. */
export const browserToolOf = (name: string): string | null =>
  name.startsWith(BROWSER_TOOL_PREFIX) ? name.slice(BROWSER_TOOL_PREFIX.length) : null

/**
 * An unknown MCP tool still deserves a readable label: `mcp__linear__list_issues`
 * reads as "List issues" instead of its wire id.
 */
export const toolDisplayName = (name: string): string => {
  const canonical = CANONICAL_TOOL_NAMES[name]
  if (canonical !== undefined) return canonical
  const parts = name.split("__")
  if (parts[0] === "mcp" && parts.length >= 3) {
    const bare = parts.slice(2).join("__").replace(/_/gu, " ").trim()
    if (bare.length > 0) return `${bare[0]!.toUpperCase()}${bare.slice(1)}`
  }
  return name
}
