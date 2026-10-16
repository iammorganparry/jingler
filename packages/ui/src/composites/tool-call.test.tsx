import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { ToolCall, toolCallLabel } from "./tool-call.js"

afterEach(cleanup)

const redIcons = (c: HTMLElement) => c.querySelectorAll("svg.text-state-failed")

describe("ToolCall", () => {
  it("shows a red icon only for a failed call", () => {
    const failed = render(<ToolCall status="error" name="Bash" target="pnpm test" meta="exit 1" />)
    expect(redIcons(failed.container)).toHaveLength(1)
    expect(failed.container.querySelector(".text-red")).toBeNull()
    cleanup()
    for (const status of ["success", "running"] as const) {
      const { container } = render(<ToolCall status={status} name="Read" target="a.ts" meta="3 lines" />)
      expect(redIcons(container)).toHaveLength(0)
      expect(container.querySelector("[data-tool-status]")?.getAttribute("data-tool-status")).toBe(status)
      cleanup()
    }
  })
})

describe("toolCallLabel", () => {
  it("intent wins the title, with detail as the stripped command", () => {
    const result = toolCallLabel({
      toolName: "command_execute",
      args: { command: "cd /work/lane-1 && pnpm test" },
      intent: "Running tests",
      cwd: "/work/lane-1"
    })
    expect(result).toEqual({ title: "Running tests", detail: "pnpm test" })
  })

  it("derives a label for command_execute from the first word", () => {
    const result = toolCallLabel({ toolName: "command_execute", args: { command: "grep -rn foo" } })
    expect(result).toEqual({ title: "Ran `grep`", detail: "grep -rn foo" })
  })

  it("derives a label for workspace_read_file from the basename", () => {
    const result = toolCallLabel({ toolName: "workspace_read_file", args: { path: "src/retry.ts" } })
    expect(result).toEqual({ title: "Read `retry.ts`", detail: "src/retry.ts" })
  })

  it("derives a label for workspace_edit and workspace_write from the basename", () => {
    expect(toolCallLabel({ toolName: "workspace_edit", args: { path: "a/b/retry.ts" } })).toEqual({
      title: "Edited `retry.ts`",
      detail: "a/b/retry.ts"
    })
    expect(toolCallLabel({ toolName: "workspace_write", args: { path: "a/b/new.ts" } })).toEqual({
      title: "Edited `new.ts`",
      detail: "a/b/new.ts"
    })
  })

  it("falls back to the tool name for anything else", () => {
    expect(toolCallLabel({ toolName: "subagent", args: {} })).toEqual({ title: "subagent", detail: null })
  })

  it("strips the cwd prefix even without intent", () => {
    const result = toolCallLabel({
      toolName: "command_execute",
      args: { command: "cd /work/lane-1 && grep -rn foo" },
      cwd: "/work/lane-1"
    })
    expect(result).toEqual({ title: "Ran `grep`", detail: "grep -rn foo" })
  })
})
