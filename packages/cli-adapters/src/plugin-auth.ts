/**
 * Consent, grants, and where a plugin's credentials actually come from.
 *
 * ## The design this file exists to make real
 *
 * A Starbase manifest has no `permissions: ["github"]` array, and that absence
 * is load-bearing. A coarse flag answers "may this plugin run gh?" when the
 * question an operator actually has is "which account, with which scopes, and
 * can I take it back?" — and a flag can express none of that.
 *
 * So access works the way it does in VS Code: the plugin asks, at the moment it
 * needs it. The operator sees a prompt naming that plugin, that provider and
 * those scopes, and their answer is recorded. The consequence worth stating is
 * that the OFFICIAL GitHub plugin holds no privilege a third-party GitHub plugin
 * could not also request — which is the only honest test of whether the API is
 * real rather than decorative.
 *
 * ## Grant identity is (plugin, provider, scopes)
 *
 * Widening scopes is a NEW request and prompts again. A plugin granted `repo`
 * last week must not be able to quietly start asking for `admin:org` — the
 * operator agreed to a specific thing, and silently upgrading it would make the
 * first agreement meaningless.
 *
 * ## Tokens never leave main
 *
 * A grant is persisted as metadata; the token is fetched from the provider on
 * use and handed to the extension host, never to the renderer. `AuthSessionInfo`
 * — the shape every `Plugins.*` RPC returns — has no token field at all, so
 * there is no route by which a log line, a crash report or a devtools inspection
 * in the renderer can leak one.
 */
import { Effect, Schema } from "effect"
import type { AuthSessionInfo } from "@starbase/core"
import { PluginError } from "@starbase/core"
import { AppPaths } from "./app-paths.js"
import { FileSystem, Path } from "@effect/platform"

/** A stored grant. Metadata only — see the header. */
const StoredGrant = Schema.Struct({
  pluginId: Schema.String,
  providerId: Schema.String,
  scopes: Schema.Array(Schema.String),
  account: Schema.optional(Schema.String),
  grantedAt: Schema.String
})
type StoredGrant = Schema.Schema.Type<typeof StoredGrant>

const GrantFile = Schema.Struct({ grants: Schema.Array(StoredGrant) })

/** What a provider hands back when asked for a token. */
export interface ProviderToken {
  readonly accessToken: string
  readonly account?: string
}

/**
 * Something that can produce a token for a set of scopes.
 *
 * An interface because a plugin can BE one (`contributes.authenticationProviders`
 * — a self-hosted GitLab, an internal tool), and because the built-in `github`
 * provider is then not a special case but the first implementation of the same
 * thing every plugin uses.
 */
export interface AuthProvider {
  readonly id: string
  readonly label: string
  /** Resolve a token, or null when the provider has no credentials to give. */
  readonly getToken: (
    scopes: ReadonlyArray<string>
  ) => Effect.Effect<ProviderToken | null, never, never>
}

/** Asking the operator. Supplied by main, which owns the window. */
export interface ConsentPrompt {
  (request: {
    readonly pluginId: string
    readonly pluginName: string
    readonly providerId: string
    readonly providerLabel: string
    readonly scopes: ReadonlyArray<string>
  }): Promise<boolean>
}

/** Does an existing grant already cover everything being asked for? */
const covers = (grant: StoredGrant, scopes: ReadonlyArray<string>): boolean =>
  scopes.every((scope) => grant.scopes.includes(scope))

const sameGrant = (grant: StoredGrant, pluginId: string, providerId: string): boolean =>
  grant.pluginId === pluginId && grant.providerId === providerId

/**
 * Grants persisted under `~/starbase`, and the consent flow around them.
 *
 * Deliberately not a `Schema.TaggedError`-heavy service: the only failure a
 * caller can act on is "no such provider" or "declined", and both are modelled
 * as values rather than defects.
 */
export class PluginAuth extends Effect.Service<PluginAuth>()("@starbase/PluginAuth", {
  accessors: true,
  effect: Effect.gen(function* () {
    const providers = new Map<string, AuthProvider>()
    let prompt: ConsentPrompt | null = null

    const grantsFile = Effect.gen(function* () {
      const paths = yield* AppPaths
      const path = yield* Path.Path
      return path.join(paths.root, "plugin-grants.json")
    })

    const readGrants = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const file = yield* grantsFile
      const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => null))
      if (!raw) return [] as ReadonlyArray<StoredGrant>
      const decoded = yield* Schema.decodeUnknown(Schema.parseJson(GrantFile))(raw).pipe(
        // A corrupt grant file reads as empty, which re-prompts. The alternative
        // — failing every request — would leave the operator unable to grant
        // anything with no way to clear it from inside the app.
        Effect.orElseSucceed(() => ({ grants: [] as ReadonlyArray<StoredGrant> }))
      )
      return decoded.grants
    })

    const writeGrants = (grants: ReadonlyArray<StoredGrant>) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const paths = yield* AppPaths
        const file = yield* grantsFile
        yield* fs.makeDirectory(paths.root, { recursive: true }).pipe(Effect.ignore)
        // The encode failure is folded here rather than left in the error
        // channel: a ParseError on data this module just constructed is a defect
        // in this module, not something a caller can act on, and letting it
        // widen every signature downstream would make PluginError meaningless.
        const encoded = yield* Schema.encode(GrantFile)({ grants }).pipe(
          Effect.mapError(
            (cause) =>
              new PluginError({
                pluginId: "<auth>",
                reason: "could not encode the grant file",
                cause
              })
          )
        )
        yield* fs
          .writeFileString(file, JSON.stringify(encoded, null, 2))
          .pipe(
            Effect.mapError(
              (cause) =>
                new PluginError({
                  pluginId: "<auth>",
                  reason: "could not persist the grant",
                  cause
                })
            )
          )
      })

    return {
      /** Register a provider. The built-in `github` one is installed at startup. */
      registerProvider: (provider: AuthProvider) =>
        Effect.sync(() => {
          providers.set(provider.id, provider)
        }),

      /** Install the consent prompt. Main supplies it; it owns the window. */
      setPrompt: (next: ConsentPrompt) =>
        Effect.sync(() => {
          prompt = next
        }),

      /** Every grant, as renderer-safe metadata. */
      list: (): Effect.Effect<
        ReadonlyArray<AuthSessionInfo>,
        never,
        FileSystem.FileSystem | Path.Path | AppPaths
      > =>
        readGrants.pipe(
          Effect.map((grants) =>
            grants.map((g) => ({
              pluginId: g.pluginId,
              providerId: g.providerId,
              scopes: g.scopes,
              grantedAt: g.grantedAt,
              ...(g.account ? { account: g.account } : {})
            }))
          )
        ),

      /** Drop a plugin's grant with one provider. The next ask prompts again. */
      revoke: (pluginId: string, providerId: string) =>
        Effect.gen(function* () {
          const grants = yield* readGrants
          yield* writeGrants(grants.filter((g) => !sameGrant(g, pluginId, providerId)))
        }),

      /** Drop every grant a plugin holds. Called when it is uninstalled. */
      revokeAll: (pluginId: string) =>
        Effect.gen(function* () {
          const grants = yield* readGrants
          yield* writeGrants(grants.filter((g) => g.pluginId !== pluginId))
        }),

      /**
       * The call behind `ctx.authentication.getSession`.
       *
       * Returns the token when a grant covers the scopes, prompts when it does
       * not, and returns null when the operator declines or `createIfNone` is
       * false. The extension host turns null into a rejection for the prompting
       * form, matching VS Code — that translation lives there rather than here
       * so this stays a plain question with a plain answer.
       */
      getSession: (request: {
        pluginId: string
        pluginName: string
        providerId: string
        scopes: ReadonlyArray<string>
        createIfNone?: boolean
      }) =>
        Effect.gen(function* () {
          const provider = providers.get(request.providerId)
          if (!provider) {
            return yield* Effect.fail(
              new PluginError({
                pluginId: request.pluginId,
                reason: `no authentication provider with id "${request.providerId}" is registered`
              })
            )
          }

          const grants = yield* readGrants
          const existing = grants.find(
            (g) =>
              sameGrant(g, request.pluginId, request.providerId) &&
              covers(g, request.scopes)
          )

          if (!existing) {
            if (request.createIfNone === false) return null
            if (!prompt) {
              return yield* Effect.fail(
                new PluginError({
                  pluginId: request.pluginId,
                  reason: "no consent prompt is available, so access cannot be granted"
                })
              )
            }

            const approved = yield* Effect.promise(() =>
              prompt!({
                pluginId: request.pluginId,
                pluginName: request.pluginName,
                providerId: request.providerId,
                providerLabel: provider.label,
                scopes: request.scopes
              })
            )
            if (!approved) return null

            // Recorded BEFORE the token is fetched. If the provider then fails,
            // the operator's decision still stands — they should not be asked
            // the same question again because a network call went wrong.
            const merged = [
              ...grants.filter(
                (g) => !sameGrant(g, request.pluginId, request.providerId)
              ),
              {
                pluginId: request.pluginId,
                providerId: request.providerId,
                // Union with any previous scopes, so a narrower later ask does
                // not silently shrink what was already agreed.
                scopes: [
                  ...new Set([
                    ...request.scopes,
                    ...grants
                      .filter((g) => sameGrant(g, request.pluginId, request.providerId))
                      .flatMap((g) => g.scopes)
                  ])
                ],
                grantedAt: new Date().toISOString()
              }
            ]
            yield* writeGrants(merged)
          }

          const token = yield* provider.getToken(request.scopes)
          if (!token) return null
          return {
            accessToken: token.accessToken,
            scopes: request.scopes,
            ...(token.account ? { account: token.account } : {})
          }
        })
    }
  })
}) {}
