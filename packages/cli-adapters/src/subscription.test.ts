import { describe, expect, it } from "vitest"
import { billingPath, harnessEnv, METERED_ENV_KEYS } from "./subscription.js"

const ENV = { PATH: "/usr/bin", HOME: "/home/x", OPENAI_API_KEY: "sk-x", ANTHROPIC_API_KEY: "sk-y" }

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

  it("injects GH_TOKEN so a sandboxed agent can reach GitHub", () => {
    // The agent can't read the Keychain where gh keeps its token; without this
    // an autonomous `gh`/`git push` 401s even though the operator is signed in.
    const out = harnessEnv("codex", { PATH: "/usr/bin" }, false, "ghp_abc")
    expect(out.GH_TOKEN).toBe("ghp_abc")
  })

  it("does not inject when no token could be resolved", () => {
    expect(harnessEnv("codex", { PATH: "/usr/bin" }, false, null).GH_TOKEN).toBeUndefined()
  })

  it("never overrides a real token the operator already exported", () => {
    const out = harnessEnv("codex", { GH_TOKEN: "ghp_real" }, false, "ghp_resolved")
    expect(out.GH_TOKEN).toBe("ghp_real")
    const viaGithub = harnessEnv("codex", { GITHUB_TOKEN: "ghp_real" }, false, "ghp_resolved")
    expect(viaGithub.GH_TOKEN).toBeUndefined()
    expect(viaGithub.GITHUB_TOKEN).toBe("ghp_real")
  })

  it("drops an empty GH_TOKEN/GITHUB_TOKEN footgun, then injects the real one", () => {
    // An empty env token shadows the Keychain and 401s; it must not survive, and
    // the resolved token should fill the gap it leaves.
    const out = harnessEnv("codex", { GITHUB_TOKEN: "", PATH: "/usr/bin" }, false, "ghp_resolved")
    expect(out.GITHUB_TOKEN).toBeUndefined()
    expect(out.GH_TOKEN).toBe("ghp_resolved")
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
