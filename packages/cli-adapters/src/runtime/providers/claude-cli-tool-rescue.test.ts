import { describe, expect, it, vi } from "vitest"
import { makeClaudeCliToolRescue } from "./claude-cli-tool-rescue.js"

const init = (tools: ReadonlyArray<string>) => ({ type: "system", subtype: "init", tools })
const toolUse = (id: string, name: string, input: unknown) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name, input }] }
})
const rejected = (id: string, name: string) => ({
  type: "user",
  message: {
    content: [{
      type: "tool_result",
      tool_use_id: id,
      is_error: true,
      content: `<tool_use_error>Error: No such tool available: ${name}</tool_use_error>`
    }]
  }
})

describe("makeClaudeCliToolRescue", () => {
  it("hands pi a call the CLI rejected for a tool pi offered", () => {
    const warn = vi.fn()
    const observe = makeClaudeCliToolRescue(new Set(["command_execute", "workspace_read_file"]), warn)
    observe(init(["mcp__jingler__workspace_read_file"]))
    observe(toolUse("toolu_1", "mcp__jingler__command_execute", { command: "git status" }))
    expect(observe(rejected("toolu_1", "mcp__jingler__command_execute")).call).toEqual({
      id: "toolu_1",
      name: "command_execute",
      arguments: { command: "git status" }
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("1 registered, without it"))
  })

  it("rescues a call made under the bare pi name", () => {
    const observe = makeClaudeCliToolRescue(new Set(["command_inspect"]), () => {})
    observe(toolUse("toolu_2", "command_inspect", { program: "git", args: ["log"] }))
    expect(observe(rejected("toolu_2", "command_inspect")).call).toMatchObject({ name: "command_inspect" })
  })

  it("leaves a tool pi never offered rejected", () => {
    const warn = vi.fn()
    const observe = makeClaudeCliToolRescue(new Set(["workspace_read_file"]), warn)
    observe(toolUse("toolu_3", "mcp__jingler__rm_everything", {}))
    expect(observe(rejected("toolu_3", "mcp__jingler__rm_everything")).call).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown tool"))
  })

  it("ignores ordinary tool errors", () => {
    const observe = makeClaudeCliToolRescue(new Set(["command_execute"]), () => {})
    observe(toolUse("toolu_4", "mcp__jingler__command_execute", { command: "false" }))
    const failed = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_4", is_error: true, content: "exit 1" }] } }
    expect(observe(failed).call).toBeNull()
  })
})
