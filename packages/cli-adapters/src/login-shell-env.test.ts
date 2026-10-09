import { describe, expect, it } from "vitest"
import { framedEnv, loginShellEnvironment, parseEnvNul } from "./login-shell-env.js"
import { connectFailureMessage } from "./runtime/tools/mcp-tools.js"

describe("login shell environment", () => {
  it("parses NUL-separated env output, keeping newlines and '=' inside values", () => {
    expect(parseEnvNul("PATH=/a:/b\0MULTI=one\ntwo\0EQ=a=b\0junk\0")).toEqual({
      PATH: "/a:/b",
      MULTI: "one\ntwo",
      EQ: "a=b"
    })
  })

  it("reads only the framed env block, ignoring startup-file output around it", () => {
    expect(framedEnv("Welcome!\n__M__A=1\0B=two\nlines\0__M__bye", "__M__")).toEqual({ A: "1", B: "two\nlines" })
    expect(framedEnv("no markers here", "__M__")).toEqual({})
  })

  it.runIf(process.platform !== "win32")("picks up exports from an interactive zsh startup file", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { existsSync } = await import("node:fs")
    if (!existsSync("/bin/zsh")) return
    const zdot = await mkdtemp(join(tmpdir(), "jingler-zdot-"))
    await writeFile(join(zdot, ".zshrc"), "echo noisy banner\nexport JINGLER_RC_ONLY=from-zshrc\n")
    const previous = process.env.ZDOTDIR
    process.env.ZDOTDIR = zdot
    try {
      const { execFileText } = await import("./child-registry.js")
      const out = await execFileText("/bin/zsh", ["-ilc", "printf '%s' __M__; env -0; printf '%s' __M__"], { timeout: 5_000 })
      expect(framedEnv(out, "__M__").JINGLER_RC_ONLY).toBe("from-zshrc")
    } finally {
      if (previous === undefined) delete process.env.ZDOTDIR
      else process.env.ZDOTDIR = previous
      await rm(zdot, { recursive: true, force: true })
    }
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
