import { describe, expect, it } from "vitest"
import { loginShellEnvironment, parseEnvNul } from "./login-shell-env.js"
import { connectFailureMessage } from "./runtime/tools/mcp-tools.js"

describe("login shell environment", () => {
  it("parses NUL-separated env output, keeping newlines and '=' inside values", () => {
    expect(parseEnvNul("PATH=/a:/b\0MULTI=one\ntwo\0EQ=a=b\0junk\0")).toEqual({
      PATH: "/a:/b",
      MULTI: "one\ntwo",
      EQ: "a=b"
    })
  })

  it("returns nothing on Windows or without a shell", async () => {
    expect(await loginShellEnvironment("/bin/sh", "win32")).toEqual({})
    expect(await loginShellEnvironment("", "darwin")).toEqual({})
  })
})

describe("MCP connect failure message", () => {
  it("appends the server's stderr tail when there is one", () => {
    expect(connectFailureMessage(new Error("Connection closed"), "  ModuleNotFoundError: foo\n"))
      .toBe("Connection closed\nserver stderr:\nModuleNotFoundError: foo")
    expect(connectFailureMessage(new Error("spawn x ENOENT"), "")).toBe("spawn x ENOENT")
  })
})
