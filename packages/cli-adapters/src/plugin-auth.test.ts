import { describe, expect, it, vi } from "vitest"
import { Effect, Fiber, Layer } from "effect"
import { NodeContext } from "@effect/platform-node"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AppPaths } from "./app-paths.js"
import { PluginAuth, type AuthProvider, type ConsentPrompt } from "./plugin-auth.js"

/**
 * Consent is the whole design.
 *
 * A Starbase manifest has no `permissions` array, so everything an operator can
 * say about what a plugin may reach is said here — once, at the moment of
 * asking, and revocably. These tests pin the properties that make that a real
 * bargain rather than a rhetorical one: a second ask does not re-prompt, a WIDER
 * ask does, declining grants nothing, and revoking actually forgets.
 */

const tempPaths = async () => {
  const home = await mkdtemp(join(tmpdir(), "starbase-plugin-auth-"))
  const root = join(home, "starbase")
  return {
    home,
    layer: Layer.succeed(AppPaths, {
      root,
      configFile: join(root, "config.json"),
      sessionsFile: join(root, "sessions.json"),
      worktreesDir: join(root, "worktrees"),
      transcriptsDir: join(root, "transcripts"),
      reviewsDir: join(root, "reviews"),
      planRoundsDir: join(root, "plan-rounds"),
      plansDir: join(root, ".starbase"),
      themesDir: join(root, "themes"),
      pluginsDir: join(root, "plugins"),
      pluginStorageDir: join(root, "plugin-storage"),
      authFile: join(root, "auth.enc"),
      openConnectorFile: join(root, "open-connector.enc")
    } as never)
  }
}

const provider = (over: Partial<AuthProvider> = {}): AuthProvider => ({
  id: "github",
  label: "GitHub",
  getToken: () => Effect.succeed({ accessToken: "tok_123", account: "octocat" }),
  ...over
})

/**
 * Run a program against a fresh grants file.
 *
 * `R` is left open because the effects under test legitimately require
 * FileSystem / Path / AppPaths — all supplied below. Pinning it to `never` would
 * only force a cast at every call site.
 */
const withAuth = async <A, R>(
  run: (auth: PluginAuth) => Effect.Effect<A, unknown, R>,
  opts: { prompt?: ConsentPrompt; provider?: AuthProvider } = {}
) => {
  const { home, layer } = await tempPaths()
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* PluginAuth
        yield* auth.registerProvider(opts.provider ?? provider())
        if (opts.prompt) yield* auth.setPrompt(opts.prompt)
        return yield* run(auth)
      }).pipe(
        Effect.provide(PluginAuth.Default),
        Effect.provide(layer),
        Effect.provide(NodeContext.layer)
      ) as Effect.Effect<A, unknown, never>
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

const ask = (auth: PluginAuth, scopes: string[], createIfNone?: boolean) =>
  auth.getSession({
    pluginId: "linear",
    pluginName: "Linear",
    providerId: "github",
    scopes,
    ...(createIfNone === undefined ? {} : { createIfNone })
  })

describe("granting", () => {
  it("prompts, then returns a token naming the account", async () => {
    const prompt = vi.fn(async () => true)
    const session = await withAuth((auth) => ask(auth, ["repo"]), { prompt })

    expect(prompt).toHaveBeenCalledOnce()
    expect(session).toMatchObject({ accessToken: "tok_123", account: "octocat" })
  })

  it("names the plugin, provider and exact scopes in the prompt", async () => {
    // "Access your GitHub account" is the phrasing that trained people to click
    // Allow without reading. The operator is asked a specific question.
    const prompt = vi.fn(async () => true)
    await withAuth((auth) => ask(auth, ["repo", "read:org"]), { prompt })

    expect(prompt).toHaveBeenCalledWith({
      pluginId: "linear",
      pluginName: "Linear",
      providerId: "github",
      providerLabel: "GitHub",
      scopes: ["repo", "read:org"]
    })
  })

  it("grants nothing when the operator declines", async () => {
    const prompt = vi.fn(async () => false)
    const result = await withAuth(
      (auth) =>
        Effect.gen(function* () {
          const first = yield* ask(auth, ["repo"])
          const granted = yield* auth.list()
          return { first, granted }
        }),
      { prompt }
    )

    expect(result.first).toBeNull()
    // Nothing recorded, so the next ask prompts again rather than treating a
    // refusal as an answer that sticks.
    expect(result.granted).toEqual([])
  })
})

describe("re-asking", () => {
  it("does not prompt again for scopes already granted", async () => {
    const prompt = vi.fn(async () => true)
    await withAuth(
      (auth) =>
        Effect.gen(function* () {
          yield* ask(auth, ["repo"])
          yield* ask(auth, ["repo"])
        }),
      { prompt }
    )
    expect(prompt).toHaveBeenCalledOnce()
  })

  it("does not prompt for a NARROWER ask covered by the grant", async () => {
    const prompt = vi.fn(async () => true)
    await withAuth(
      (auth) =>
        Effect.gen(function* () {
          yield* ask(auth, ["repo", "read:org"])
          yield* ask(auth, ["repo"])
        }),
      { prompt }
    )
    expect(prompt).toHaveBeenCalledOnce()
  })

  it("PROMPTS AGAIN when the ask widens", async () => {
    // The property the whole model rests on. A plugin granted `repo` last week
    // must not be able to quietly start asking for `admin:org`.
    const prompt = vi.fn(async () => true)
    await withAuth(
      (auth) =>
        Effect.gen(function* () {
          yield* ask(auth, ["repo"])
          yield* ask(auth, ["repo", "admin:org"])
        }),
      { prompt }
    )
    expect(prompt).toHaveBeenCalledTimes(2)
  })

  it("keeps previously granted scopes when a later ask is narrower", async () => {
    const prompt = vi.fn(async () => true)
    const granted = await withAuth(
      (auth) =>
        Effect.gen(function* () {
          yield* ask(auth, ["repo", "read:org"])
          yield* ask(auth, ["repo"])
          return yield* auth.list()
        }),
      { prompt }
    )
    expect(granted[0]?.scopes).toEqual(expect.arrayContaining(["repo", "read:org"]))
  })
})

describe("createIfNone: false", () => {
  it("never prompts, and answers null when there is no grant", async () => {
    const prompt = vi.fn(async () => true)
    const session = await withAuth((auth) => ask(auth, ["repo"], false), { prompt })
    expect(prompt).not.toHaveBeenCalled()
    expect(session).toBeNull()
  })

  it("returns the token when a grant already exists", async () => {
    const prompt = vi.fn(async () => true)
    const session = await withAuth(
      (auth) =>
        Effect.gen(function* () {
          yield* ask(auth, ["repo"])
          return yield* ask(auth, ["repo"], false)
        }),
      { prompt }
    )
    expect(session).toMatchObject({ accessToken: "tok_123" })
  })
})

describe("what the renderer is allowed to see", () => {
  it("lists metadata with no token anywhere in it", async () => {
    // `AuthSessionInfo` has no token field, and that absence is the security
    // boundary rather than an omission.
    const granted = await withAuth(
      (auth) =>
        Effect.gen(function* () {
          yield* ask(auth, ["repo"])
          return yield* auth.list()
        }),
      { prompt: async () => true }
    )

    expect(granted).toHaveLength(1)
    expect(granted[0]).toMatchObject({ pluginId: "linear", providerId: "github" })
    expect(JSON.stringify(granted)).not.toContain("tok_123")
  })
})

describe("revoking", () => {
  it("makes the next ask prompt again", async () => {
    const prompt = vi.fn(async () => true)
    await withAuth(
      (auth) =>
        Effect.gen(function* () {
          yield* ask(auth, ["repo"])
          yield* auth.revoke("linear", "github")
          yield* ask(auth, ["repo"])
        }),
      { prompt }
    )
    expect(prompt).toHaveBeenCalledTimes(2)
  })

  it("revokeAll forgets every provider for a plugin", async () => {
    const granted = await withAuth(
      (auth) =>
        Effect.gen(function* () {
          yield* ask(auth, ["repo"])
          yield* auth.revokeAll("linear")
          return yield* auth.list()
        }),
      { prompt: async () => true }
    )
    expect(granted).toEqual([])
  })
})

describe("failure modes", () => {
  it("fails for a provider nobody registered", async () => {
    await expect(
      withAuth(
        (auth) =>
          auth.getSession({
            pluginId: "linear",
            pluginName: "Linear",
            providerId: "gitlab",
            scopes: []
          }),
        { prompt: async () => true }
      )
    ).rejects.toThrow(/no authentication provider/)
  })

  it("returns null when the provider has no credentials to give", async () => {
    // An unauthenticated `gh` is the common case. A plugin should degrade, not
    // see a stack trace about a binary it never mentioned.
    const session = await withAuth((auth) => ask(auth, ["repo"]), {
      prompt: async () => true,
      provider: provider({ getToken: () => Effect.succeed(null) })
    })
    expect(session).toBeNull()
  })

  it("keeps the grant when the provider fails after consent", async () => {
    // The operator's decision stands. Asking them the same question again
    // because a network call went wrong would train them to click through it.
    const prompt = vi.fn(async () => true)
    await withAuth(
      (auth) =>
        Effect.gen(function* () {
          yield* ask(auth, ["repo"])
          yield* ask(auth, ["repo"])
        }),
      {
        prompt,
        provider: provider({ getToken: () => Effect.succeed(null) })
      }
    )
    expect(prompt).toHaveBeenCalledOnce()
  })
})

describe("concurrent grant-file mutations", () => {
  /**
   * The grant file is read-whole, change-one, write-whole — and BOTH halves are
   * async filesystem effects, so every mutation has an interleaving window. Two
   * writers that each read the same list will each write a list missing the
   * other's change, and the last write wins.
   *
   * A lost grant only re-prompts. A lost REVOCATION hands back access the
   * operator had just taken away, which is the one that has to be impossible.
   */

  it("does not lose a revocation to a concurrent revocation of another grant", async () => {
    // Settings dispatches these through `mutateAsync` with nothing ordering
    // them. Unserialised, both read a two-grant list and each writes back the
    // one-grant list it computed — so whichever lands second resurrects the
    // grant the first removed, and the operator watches a row they just deleted
    // reappear.
    const remaining = await withAuth(
      (auth) =>
        Effect.gen(function* () {
          yield* auth.getSession({
            pluginId: "linear",
            pluginName: "Linear",
            providerId: "github",
            scopes: ["repo"]
          })
          yield* auth.getSession({
            pluginId: "jira",
            pluginName: "Jira",
            providerId: "github",
            scopes: ["repo"]
          })

          yield* Effect.all(
            [auth.revoke("linear", "github"), auth.revoke("jira", "github")],
            { concurrency: "unbounded" }
          )

          return yield* auth.list()
        }),
      { prompt: async () => true }
    )

    expect(remaining).toEqual([])
  })

  it("does not resurrect a grant revoked while another plugin's prompt was open", async () => {
    // The window this closes is the widest one in the module: `getSession`
    // reads, awaits an operator-paced native dialog, then writes. A revoke
    // performed during that dialog is inside the gap.
    //
    // The prompt below performs the revoke, which is exactly when a real
    // operator would: the consent dialog is up, and they tidy Settings behind
    // it. Before the fix, jira's post-consent write was computed from a list
    // read before the dialog opened — one that still contained linear's grant —
    // so approving jira silently restored linear.
    // Two hand-rolled gates, so the race is deterministic rather than hopeful:
    // the test blocks until jira's dialog is genuinely open, does the revoke,
    // and only then lets the dialog return.
    let opened!: () => void
    const promptOpened = new Promise<void>((res) => {
      opened = res
    })
    let release!: () => void
    const promptReleased = new Promise<void>((res) => {
      release = res
    })

    const remaining = await withAuth(
      (auth) =>
        Effect.gen(function* () {
          yield* auth.getSession({
            pluginId: "linear",
            pluginName: "Linear",
            providerId: "github",
            scopes: ["repo"]
          })

          // jira asks, and its prompt parks open.
          const asking = yield* Effect.fork(
            auth.getSession({
              pluginId: "jira",
              pluginName: "Jira",
              providerId: "github",
              scopes: ["repo"]
            })
          )
          yield* Effect.promise(() => promptOpened)

          // The operator tidies Settings behind the open dialog.
          yield* auth.revoke("linear", "github")

          release()
          yield* Fiber.join(asking)

          return yield* auth.list()
        }),
      {
        prompt: async (req) => {
          if (req.pluginId !== "jira") return true
          opened()
          await promptReleased
          return true
        }
      }
    )

    // linear stays revoked. Before the fix, jira's post-consent write merged
    // into a list read before its dialog opened — one that still had linear in
    // it — so approving jira silently restored it.
    expect(remaining.map((g) => g.pluginId)).toEqual(["jira"])
  })
})
