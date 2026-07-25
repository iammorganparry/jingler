import { FileSystem } from "@effect/platform"
import type { McpInjectionTarget, OpenConnectorConfig } from "@starbase/core"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AppPaths } from "./app-paths.js"
import { ConfigService } from "./config.js"
import { OpenConnectorService } from "./open-connector.js"
import { InMemorySecretStoreLive, SecretStore } from "./secret-store.js"
import { runExit, withTempRoot } from "./test-support.js"

/**
 * OpenConnectorService owns the unified-MCP injection. These tests pin the
 * SECURITY contract (the bearer never appears in the redacted `.server` half) and
 * the null-cases that decide whether an agent gets the server at all. Run against
 * a real temp `~/starbase` + an in-memory SecretStore.
 */
describe("OpenConnectorService", () => {
  let temp: ReturnType<typeof withTempRoot>
  beforeEach(() => {
    temp = withTempRoot()
  })
  afterEach(() => temp.cleanup())

  const Services = Layer.mergeAll(
    OpenConnectorService.Default,
    ConfigService.Default,
    InMemorySecretStoreLive
  )

  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      OpenConnectorService | ConfigService | SecretStore | AppPaths | FileSystem.FileSystem
    >
  ) => runExit(effect.pipe(Effect.provide(Services)), temp.layer)

  const CONFIG: OpenConnectorConfig = {
    endpoint: "https://mcp.internal",
    enabled: true,
    serverName: "open-connector"
  }

  it("injects nothing when the feature is disabled (the shipped default)", async () => {
    const exit = await run(OpenConnectorService.injection("claude"))
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") expect(exit.value).toBeNull()
  })

  it("injects nothing when enabled but no token is stored", async () => {
    const exit = await run(
      Effect.gen(function* () {
        yield* OpenConnectorService.set(CONFIG) // no token
        return yield* OpenConnectorService.injection("claude")
      })
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") expect(exit.value).toBeNull()
  })

  it("injects a redacted+launch entry when enabled with a token — bearer only on the launch half", async () => {
    const exit = await run(
      Effect.gen(function* () {
        yield* OpenConnectorService.set(CONFIG, "sk-secret-123")
        return yield* OpenConnectorService.injection("claude")
      })
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag !== "Success" || exit.value === null) throw new Error("expected an injection")
    const entry = exit.value
    // Redacted half: names only, and the URL carries no query/secret.
    expect(entry.server.transport).toBe("http")
    expect(entry.server.target).toBe("https://mcp.internal/mcp")
    expect(entry.server.headerKeys).toEqual(["Authorization"])
    expect(JSON.stringify(entry.server)).not.toContain("sk-secret-123")
    // Launch half: the real bearer, kept out of anything that crosses RPC.
    expect(entry.launch.url).toBe("https://mcp.internal/mcp")
    expect(entry.launch.headers.Authorization).toBe("Bearer sk-secret-123")
  })

  it("withholds the server from a harness explicitly disabled in perCli", async () => {
    const exit = await run(
      Effect.gen(function* () {
        yield* OpenConnectorService.set({ ...CONFIG, perCli: { codex: false } }, "tok")
        return {
          claude: yield* OpenConnectorService.injection("claude"),
          codex: yield* OpenConnectorService.injection("codex")
        }
      })
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value.claude).not.toBeNull()
      expect(exit.value.codex).toBeNull()
    }
  })

  it("reports hasToken without exposing the token, and clears it on an empty set", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const before = yield* OpenConnectorService.get
        yield* OpenConnectorService.set(CONFIG, "tok")
        const withToken = yield* OpenConnectorService.get
        // token omitted → preserved
        yield* OpenConnectorService.set(CONFIG)
        const stillThere = yield* OpenConnectorService.get
        // token null → cleared
        yield* OpenConnectorService.set(CONFIG, null)
        const cleared = yield* OpenConnectorService.get
        return { before, withToken, stillThere, cleared }
      })
    )
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value.before.hasToken).toBe(false)
      expect(exit.value.withToken.hasToken).toBe(true)
      expect(exit.value.stillThere.hasToken).toBe(true)
      expect(exit.value.cleared.hasToken).toBe(false)
      // The config carries no token field in any shape.
      expect(JSON.stringify(exit.value.withToken.config)).not.toContain("tok")
    }
  })

  /**
   * `injectionTargets` is what Settings › Connectors renders. It exists so the
   * claim "every agent gets these tools" is answered by the resolver rather than
   * re-derived in the renderer — these pin the four distinct ways it can be false,
   * because from the config alone they all look like one "off".
   */
  describe("injectionTargets", () => {
    const byCli = (targets: ReadonlyArray<McpInjectionTarget>, cli: string) =>
      targets.find((t) => t.cli === cli)

    it("reports every harness as not injected, with a reason, when unconfigured", async () => {
      const exit = await run(OpenConnectorService.injectionTargets)
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(exit.value.map((t) => t.cli)).toStrictEqual(["claude", "codex", "cursor", "opencode"])
      expect(exit.value.every((t) => !t.injected)).toBe(true)
      expect(byCli(exit.value, "claude")?.skipped).toBe("disabled")
    })

    it("distinguishes a missing token from a disabled feature", async () => {
      const exit = await run(
        Effect.gen(function* () {
          yield* OpenConnectorService.set(CONFIG) // enabled, no token
          return yield* OpenConnectorService.injectionTargets
        })
      )
      expect(exit._tag).toBe("Success")
      if (exit._tag === "Success") expect(byCli(exit.value, "codex")?.skipped).toBe("no-token")
    })

    it("marks every runnable harness injected — and cursor as having no run path", async () => {
      const exit = await run(
        Effect.gen(function* () {
          yield* OpenConnectorService.set(CONFIG, "tok")
          return yield* OpenConnectorService.injectionTargets
        })
      )
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      for (const cli of ["claude", "codex", "opencode"]) {
        const target = byCli(exit.value, cli)
        expect(target?.injected).toBe(true)
        expect(target?.url).toBe("https://mcp.internal/mcp")
        expect(target?.serverName).toBe("open-connector")
      }
      // Cursor resolves a server but Starbase never launches it — reporting that as
      // "injected" would promise tools to an agent that never starts.
      expect(byCli(exit.value, "cursor")?.injected).toBe(false)
      expect(byCli(exit.value, "cursor")?.skipped).toBe("no-run-path")
    })

    it("reports a per-harness opt-out distinctly from the master switch", async () => {
      const exit = await run(
        Effect.gen(function* () {
          yield* OpenConnectorService.set({ ...CONFIG, perCli: { codex: false } }, "tok")
          return yield* OpenConnectorService.injectionTargets
        })
      )
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(byCli(exit.value, "codex")?.injected).toBe(false)
      expect(byCli(exit.value, "codex")?.skipped).toBe("opted-out")
      expect(byCli(exit.value, "claude")?.injected).toBe(true)
    })

    /** The redaction contract, at the boundary the renderer actually sees. */
    it("never carries the bearer — header NAMES only", async () => {
      const exit = await run(
        Effect.gen(function* () {
          yield* OpenConnectorService.set(CONFIG, "sk-live-DO-NOT-LEAK")
          return yield* OpenConnectorService.injectionTargets
        })
      )
      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      expect(JSON.stringify(exit.value)).not.toContain("sk-live-DO-NOT-LEAK")
      expect(byCli(exit.value, "claude")?.headerKeys).toStrictEqual(["Authorization"])
    })
  })

  it("test() returns a failed status (never throws) when unconfigured", async () => {
    const exit = await run(OpenConnectorService.test)
    expect(exit._tag).toBe("Success")
    if (exit._tag === "Success") {
      expect(exit.value.state).toBe("failed")
      expect(exit.value.error).toMatch(/endpoint/i)
    }
  })
})
