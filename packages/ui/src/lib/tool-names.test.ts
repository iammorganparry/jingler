import { describe, expect, it } from "vitest"
import { toolDisplayName } from "./tool-names.js"

describe("toolDisplayName", () => {
  it("maps runtime and pi-native ids onto one design", () => {
    expect(toolDisplayName("workspace_read_file")).toBe("Read")
    expect(toolDisplayName("read")).toBe("Read")
    expect(toolDisplayName("command_execute")).toBe("Bash")
    expect(toolDisplayName("debug")).toBe("Debug")
  })

  it("names the in-app browser tools", () => {
    expect(toolDisplayName("mcp__jingler-browser__navigate")).toBe("Navigate")
    expect(toolDisplayName("mcp__jingler-browser__read_text")).toBe("Read page")
    expect(toolDisplayName("mcp__jingler-browser__evaluate")).toBe("Evaluate")
  })

  it("humanises unknown MCP ids and passes everything else through", () => {
    expect(toolDisplayName("mcp__linear__list_issues")).toBe("List issues")
    expect(toolDisplayName("mcp__my_server__create_page")).toBe("Create page")
    expect(toolDisplayName("SomePluginTool")).toBe("SomePluginTool")
  })
})
