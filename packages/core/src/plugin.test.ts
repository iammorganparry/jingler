import { describe, expect, it } from "vitest"
import { Either, Schema } from "effect"
import {
  ActivationEvent,
  AuthSessionInfo,
  ContributionId,
  PluginCatalog,
  PluginError,
  PluginId,
  PluginManifest
} from "./plugin.js"

/** The smallest manifest that should load: a pure-UI plugin with one tab. */
const HELLO = {
  id: "hello",
  name: "Hello",
  version: "1.0.0",
  ui: "dist/ui.js",
  activationEvents: ["onTab:hello.greeting"],
  contributes: {
    tabs: [{ id: "hello.greeting", label: "Hello", icon: "MessagesSquare" }]
  }
}

const decode = Schema.decodeUnknownEither(PluginManifest)

/** The failure message, flattened — what an operator would read in Settings. */
const errorOf = (input: unknown): string => {
  const result = decode(input)
  if (Either.isRight(result)) throw new Error("expected a decode failure")
  return String(result.left)
}

describe("PluginId", () => {
  const ok = Schema.decodeUnknownEither(PluginId)

  it("accepts lowercase kebab-case", () => {
    expect(Either.isRight(ok("github-pull-requests"))).toBe(true)
  })

  it.each([
    ["uppercase", "GitHub"],
    ["a dot, which would break contribution namespacing", "my.plugin"],
    ["a slash, which would escape the plugins directory", "a/b"],
    ["path traversal", ".."],
    ["a leading dash", "-nope"],
    ["empty", ""]
  ])("rejects %s", (_why, id) => {
    expect(Either.isLeft(ok(id))).toBe(true)
  })
})

describe("ContributionId", () => {
  const ok = Schema.decodeUnknownEither(ContributionId)

  it("accepts <pluginId>.<local>", () => {
    expect(Either.isRight(ok("linear.issues"))).toBe(true)
  })

  it("rejects a bare id, which two plugins could collide on", () => {
    expect(Either.isLeft(ok("issues"))).toBe(true)
  })

  it("rejects a third segment", () => {
    expect(Either.isLeft(ok("a.b.c"))).toBe(true)
  })
})

describe("ActivationEvent", () => {
  const ok = Schema.decodeUnknownEither(ActivationEvent)

  it.each([
    "onStartupFinished",
    "onCommand:github-pull-requests.merge",
    "onTab:linear.issues",
    "repoContains:Cargo.toml"
  ])("accepts %s", (event) => {
    expect(Either.isRight(ok(event))).toBe(true)
  })

  it("rejects an unknown event rather than ignoring it", () => {
    // A typo'd event silently never fires, and a plugin that never activates is
    // indistinguishable from one that is broken. Fail at decode instead.
    expect(Either.isLeft(ok("onStartup"))).toBe(true)
  })

  it("rejects an activation event whose target id is not namespaced", () => {
    expect(Either.isLeft(ok("onTab:issues"))).toBe(true)
  })
})

describe("PluginManifest", () => {
  it("decodes a minimal pure-UI plugin", () => {
    const result = decode(HELLO)
    expect(Either.isRight(result)).toBe(true)
  })

  it("decodes a plugin with no activationEvents — its host half simply never runs", () => {
    const { activationEvents: _dropped, ...uiOnly } = HELLO
    expect(Either.isRight(decode(uiOnly))).toBe(true)
  })

  it.each(["id", "name", "version"])("fails when %s is missing", (field) => {
    const { [field]: _dropped, ...partial } = HELLO as Record<string, unknown>
    expect(errorOf(partial)).toContain(field)
  })

  it("rejects an empty name rather than rendering a nameless tab", () => {
    expect(Either.isLeft(decode({ ...HELLO, name: "" }))).toBe(true)
  })

  it("names the offending contribution when it is namespaced under another plugin", () => {
    const message = errorOf({
      ...HELLO,
      contributes: { tabs: [{ id: "other.greeting", label: "Hello" }] }
    })
    expect(message).toContain("other.greeting")
    expect(message).toContain("hello")
  })

  it("checks namespacing across every contribution point, not just tabs", () => {
    const message = errorOf({
      ...HELLO,
      contributes: {
        ...HELLO.contributes,
        commands: [{ id: "elsewhere.run", title: "Run" }]
      }
    })
    expect(message).toContain("elsewhere.run")
  })

  it("rejects a keybinding pointing at a command the plugin does not contribute", () => {
    // Otherwise the chord is claimed, wins its collision, and does nothing.
    const message = errorOf({
      ...HELLO,
      contributes: {
        ...HELLO.contributes,
        keybindings: [{ command: "hello.absent", key: "ctrl+shift+h" }]
      }
    })
    expect(message).toContain("hello.absent")
  })

  it("accepts a keybinding whose command it does contribute", () => {
    const result = decode({
      ...HELLO,
      contributes: {
        ...HELLO.contributes,
        commands: [{ id: "hello.wave", title: "Wave" }],
        keybindings: [{ command: "hello.wave", key: "ctrl+shift+h" }]
      }
    })
    expect(Either.isRight(result)).toBe(true)
  })

  it("has no permission field that could grant blanket git or gh access", () => {
    // The whole point of the auth-provider model: coarse capability flags are
    // not expressible, so they cannot creep back in via an unknown-key passthrough.
    const result = decode({ ...HELLO, permissions: ["gh", "git"] })
    expect(Either.isRight(result)).toBe(true)
    if (Either.isLeft(result)) return
    expect(result.right).not.toHaveProperty("permissions")
  })

  it("carries untrusted-repo capabilities through", () => {
    const result = decode({
      ...HELLO,
      capabilities: {
        untrustedRepos: {
          supported: "limited",
          description: "Reads the repo but runs nothing from it",
          restrictedContributions: ["hello.greeting"]
        }
      }
    })
    expect(Either.isRight(result)).toBe(true)
  })
})

describe("AuthSessionInfo", () => {
  it("drops a token if one is ever handed to it", () => {
    // Settings needs to list and revoke grants; it never needs the secret. This
    // schema is the boundary that keeps a token out of renderer-visible state.
    const decoded = Schema.decodeUnknownSync(AuthSessionInfo)({
      pluginId: "github-pull-requests",
      providerId: "github",
      account: "octocat",
      scopes: ["repo"],
      grantedAt: "2026-07-25T10:00:00.000Z",
      accessToken: "ghp_should_never_survive"
    })
    expect(decoded).not.toHaveProperty("accessToken")
    expect(JSON.stringify(decoded)).not.toContain("ghp_")
  })
})

describe("PluginCatalog", () => {
  it("carries failures alongside working plugins so one bad manifest never empties the set", () => {
    const decoded = Schema.decodeUnknownSync(PluginCatalog)({
      plugins: [
        {
          manifest: HELLO,
          dir: "/home/dev/starbase/plugins/hello",
          enabled: true,
          activated: false,
          builtin: false
        }
      ],
      failed: [
        {
          dir: "broken",
          kind: "manifest-invalid",
          message: "activationEvents: unknown event \"onStartup\""
        }
      ]
    })
    expect(decoded.plugins).toHaveLength(1)
    expect(decoded.failed[0]?.message).toContain("onStartup")
  })
})

describe("PluginError", () => {
  it("round-trips across the RPC boundary as a tagged error", () => {
    const error = new PluginError({
      pluginId: "hello",
      reason: "activate() threw: connect ECONNREFUSED"
    })
    const encoded = Schema.encodeSync(PluginError)(error)
    const decoded = Schema.decodeUnknownSync(PluginError)(encoded)
    expect(decoded._tag).toBe("PluginError")
    expect(decoded.reason).toContain("ECONNREFUSED")
  })
})
