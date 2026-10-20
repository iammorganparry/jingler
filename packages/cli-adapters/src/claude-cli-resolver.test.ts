import { describe, expect, it } from "vitest"
import { resolveClaudeBinary } from "./claude-cli-resolver.js"

const noFiles = async (): Promise<boolean> => false

describe("resolveClaudeBinary", () => {
  it("returns an explicit override untouched", async () => {
    expect(await resolveClaudeBinary("/custom/claude")).toBe("/custom/claude")
  })

  it("prefers JINGLER_CLAUDE_BINARY over every search", async () => {
    expect(
      await resolveClaudeBinary(undefined, {
        env: { JINGLER_CLAUDE_BINARY: "/env/claude", PATH: "/usr/bin" },
        fileExists: async () => true
      })
    ).toBe("/env/claude")
  })

  it("finds claude on the current process PATH", async () => {
    const result = await resolveClaudeBinary(undefined, {
      env: { PATH: "/usr/bin:/opt/claude-dir" },
      fileExists: async (path) => path === "/opt/claude-dir/claude",
      loginShellEnv: async () => ({})
    })
    expect(result).toBe("/opt/claude-dir/claude")
  })

  it("falls back to the login-shell PATH when the process PATH misses it", async () => {
    const result = await resolveClaudeBinary(undefined, {
      env: { PATH: "/usr/bin" },
      fileExists: async (path) => path === "/opt/homebrew/bin/claude",
      loginShellEnv: async () => ({ PATH: "/opt/homebrew/bin" })
    })
    expect(result).toBe("/opt/homebrew/bin/claude")
  })

  it("falls back to Homebrew/manual-install directories when PATH searches miss", async () => {
    const result = await resolveClaudeBinary(undefined, {
      env: { PATH: "/usr/bin" },
      homeDir: "/Users/op",
      fileExists: async (path) => path === "/Users/op/.claude/local/claude",
      loginShellEnv: async () => ({})
    })
    expect(result).toBe("/Users/op/.claude/local/claude")
  })

  it("checks claude in every source before trying the hsclaude wrapper", async () => {
    const checked: Array<string> = []
    const result = await resolveClaudeBinary(undefined, {
      env: { PATH: "/usr/bin" },
      homeDir: "/Users/op",
      fileExists: async (path) => {
        checked.push(path)
        return path === "/usr/local/bin/hsclaude"
      },
      loginShellEnv: async () => ({ PATH: "/opt/homebrew/bin" })
    })
    expect(result).toBe("/usr/local/bin/hsclaude")
    // every "claude" candidate (PATH, login-shell PATH, fallback dirs) is checked
    // before any "hsclaude" candidate.
    const firstHsclaudeIndex = checked.findIndex((path) => path.endsWith("hsclaude"))
    const lastClaudeIndex = checked.map((path) => path.endsWith("/claude")).lastIndexOf(true)
    expect(firstHsclaudeIndex).toBeGreaterThan(lastClaudeIndex)
  })

  it("tries the login shell only once even when searching for both names", async () => {
    let calls = 0
    await resolveClaudeBinary(undefined, {
      env: { PATH: "/usr/bin" },
      fileExists: noFiles,
      loginShellEnv: async () => {
        calls += 1
        return {}
      }
    })
    expect(calls).toBe(1)
  })

  it("falls back to the bare name when nothing is found", async () => {
    expect(
      await resolveClaudeBinary(undefined, {
        env: { PATH: "/usr/bin" },
        fileExists: noFiles,
        loginShellEnv: async () => ({})
      })
    ).toBe("claude")
  })

  it("skips the login shell and fallback search once PATH already has claude", async () => {
    let loginShellCalls = 0
    const result = await resolveClaudeBinary(undefined, {
      env: { PATH: "/usr/bin" },
      fileExists: async (path) => path === "/usr/bin/claude",
      loginShellEnv: async () => {
        loginShellCalls += 1
        return {}
      }
    })
    expect(result).toBe("/usr/bin/claude")
    expect(loginShellCalls).toBe(0)
  })
})
