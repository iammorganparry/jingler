import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  billingPath,
  cloudClaudeCredential,
  cloudCodexCredential,
  harnessEnv,
  METERED_ENV_KEYS
} from "./subscription.js"

const ENV = { PATH: "/usr/bin", HOME: "/home/x", OPENAI_API_KEY: "sk-x", ANTHROPIC_API_KEY: "sk-y" }
const temporaryHomes: string[] = []

afterEach(() => {
  delete process.env.JINGLER_HARNESS_HOME
  for (const directory of temporaryHomes.splice(0)) rmSync(directory, { recursive: true })
})

const harnessHome = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "jingler-subscription-"))
  temporaryHomes.push(directory)
  process.env.JINGLER_HARNESS_HOME = directory
  return directory
}

describe("harnessEnv", () => {
  it("withholds the metered key when the harness has a plan", () => {
    // The whole point: Jingler drives what you already pay for, and an
    // exported key silently overrides that with per-token billing.
    const out = harnessEnv("codex", ENV, true)
    expect(out.OPENAI_API_KEY).toBeUndefined()
    expect(out.PATH).toBe("/usr/bin")
  })

  it("leaves a key alone when there is no plan to fall back on", () => {
    // An operator with only an API key must keep working. Enforcing a
    // preference they cannot satisfy would be worse than the problem.
    expect(harnessEnv("codex", ENV, false).OPENAI_API_KEY).toBe("sk-x")
  })

  it("only withholds the key belonging to THAT harness", () => {
    // Claude's plan says nothing about how Codex should be billed.
    const out = harnessEnv("claude", ENV, true)
    expect(out.ANTHROPIC_API_KEY).toBeUndefined()
    expect(out.OPENAI_API_KEY).toBe("sk-x")
  })

  it("never touches opencode, whose whole model is bring-your-own-key", () => {
    // Stripping here would disable the providers opencode exists to reach.
    expect(METERED_ENV_KEYS.opencode).toBeUndefined()
    expect(harnessEnv("opencode", ENV, true)).toStrictEqual(ENV)
  })

  it("returns a complete environment, because the SDKs replace rather than merge", () => {
    // A partial env would strand the child without PATH or HOME.
    const out = harnessEnv("codex", ENV, true)
    expect(Object.keys(out).sort()).toStrictEqual(["ANTHROPIC_API_KEY", "HOME", "PATH"])
  })

  it("drops undefined values rather than passing them through", () => {
    expect(harnessEnv("claude", { A: undefined, B: "b" }, false)).toStrictEqual({ B: "b" })
  })
})

describe("billingPath", () => {
  it("reports what a run will actually be charged to", () => {
    // Surfaced even when nothing is changed: the silent case is the one that
    // cost money.
    expect(billingPath("codex", ENV, true)).toBe("subscription")
    expect(billingPath("codex", ENV, false)).toBe("api-key")
    expect(billingPath("codex", { PATH: "/usr/bin" }, false)).toBe("unknown")
  })

  it("does not call an empty key a key", () => {
    expect(billingPath("codex", { OPENAI_API_KEY: "" }, false)).toBe("unknown")
  })

  it("separates a probe that could not look from one that found nothing", () => {
    // The two read the same to the code and completely differently to a person.
    // "not signed in" tells an operator to go and sign in; if the truth is that
    // we failed to READ their credentials, they may already be signed in and we
    // have sent them to fix something that is not broken.
    expect(billingPath("codex", { PATH: "/usr/bin" }, false, false)).toBe("unknown")
    expect(billingPath("codex", { PATH: "/usr/bin" }, false, true)).toBe("undetermined")
  })

  it("still answers definitively when a key is present, probe or no probe", () => {
    // The plan probe failing does not make the billing ambiguous: that key IS
    // what the run gets charged to.
    expect(billingPath("codex", ENV, false, true)).toBe("api-key")
  })
})

describe("cloudCodexCredential", () => {
  it("returns only a bounded explicit API key", () => {
    const home = harnessHome()
    expect(cloudCodexCredential({ OPENAI_API_KEY: `sk-${"a".repeat(30)}` }, 1_000, home)).toEqual({
      kind: "api-key",
      token: `sk-${"a".repeat(30)}`,
      expiresAt: 87_400
    })
    expect(cloudCodexCredential({ OPENAI_API_KEY: "short" }, 1_000, home)).toBeNull()
  })

  it("reads current ChatGPT subscription auth without copying refresh credentials", () => {
    const home = harnessHome()
    mkdirSync(join(home, ".codex"), { recursive: true })
    const payload = Buffer.from(JSON.stringify({ exp: 5_000 })).toString("base64url")
    const token = `${"a".repeat(24)}.${payload}.${"b".repeat(24)}`
    writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({
      tokens: {
        access_token: token,
        refresh_token: "must-not-leave-the-device",
        account_id: "12345678-1234-1234-1234-123456789abc"
      }
    }))
    expect(cloudCodexCredential({ OPENAI_API_KEY: `sk-${"m".repeat(30)}` }, 1_000, home)).toEqual({
      kind: "chatgpt",
      token,
      accountId: "12345678-1234-1234-1234-123456789abc",
      expiresAt: 5_000
    })
  })
})

describe("cloudClaudeCredential", () => {
  it("extracts only the current Claude OAuth access token", () => {
    const home = harnessHome()
    mkdirSync(join(home, ".claude"), { recursive: true })
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: `oauth-${"a".repeat(30)}`,
        refreshToken: "must-not-leave-the-device",
        expiresAt: 5_000_000
      },
      mcpOauth: { secret: "must-not-leave-the-device" }
    }))
    expect(cloudClaudeCredential({ ANTHROPIC_API_KEY: `sk-${"m".repeat(30)}` }, 1_000, home)).toEqual({
      kind: "oauth",
      token: `oauth-${"a".repeat(30)}`,
      expiresAt: 5_000_000
    })
  })
})
