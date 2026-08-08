/**
 * Secret settings owned by plugins.
 *
 * This is deliberately not `SecretStore`: that service owns Jingler's sign-in
 * and OpenConnector bearer tokens. Plugin credentials have a different
 * namespace, renderer boundary and uninstall lifecycle, so combining the two
 * would let a plugin-settings change disturb app authentication.
 *
 * The service is storage-agnostic. Electron supplies the encrypted file-backed
 * implementation; tests use the in-memory implementation below.
 */
import { Context, Data, Effect, Layer, Ref } from "effect"

export class PluginSecretStoreUnavailable extends Data.TaggedError(
  "PluginSecretStoreUnavailable"
)<{
  readonly message: string
}> {}

export interface PluginSecretStoreShape {
  /** Resolve one secret for its owning plugin, or null when it is not configured. */
  readonly get: (pluginId: string, settingId: string) => Effect.Effect<string | null>
  /** Persist one secret. The renderer receives only success/failure, never the value. */
  readonly set: (
    pluginId: string,
    settingId: string,
    value: string
  ) => Effect.Effect<void, PluginSecretStoreUnavailable>
  /** Remove one secret (idempotent). */
  readonly clear: (
    pluginId: string,
    settingId: string
  ) => Effect.Effect<void, PluginSecretStoreUnavailable>
  /** Renderer-safe configured state for one secret. */
  readonly status: (pluginId: string, settingId: string) => Effect.Effect<boolean>
  /** Remove every secret owned by a plugin during uninstall (idempotent). */
  readonly clearPlugin: (
    pluginId: string
  ) => Effect.Effect<void, PluginSecretStoreUnavailable>
}

export class PluginSecretStore extends Context.Tag("@jingler/PluginSecretStore")<
  PluginSecretStore,
  PluginSecretStoreShape
>() {}

type SecretDocument = Record<string, Record<string, string>>

/** Build the test/e2e in-memory implementation, optionally seeded by namespace. */
export const makeInMemoryPluginSecretStore = (
  initial: SecretDocument = {}
): Effect.Effect<PluginSecretStoreShape> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make<SecretDocument>(initial)
    const get = (pluginId: string, settingId: string) =>
      Ref.get(ref).pipe(Effect.map((all) => all[pluginId]?.[settingId] ?? null))

    return {
      get,
      set: (pluginId, settingId, value) =>
        Ref.update(ref, (all) => ({
          ...all,
          [pluginId]: { ...all[pluginId], [settingId]: value }
        })),
      clear: (pluginId, settingId) =>
        Ref.update(ref, (all) => {
          const plugin = all[pluginId]
          if (!plugin || !(settingId in plugin)) return all
          const { [settingId]: _removed, ...remaining } = plugin
          if (Object.keys(remaining).length > 0) {
            return { ...all, [pluginId]: remaining }
          }
          const { [pluginId]: _emptyPlugin, ...otherPlugins } = all
          return otherPlugins
        }),
      status: (pluginId, settingId) =>
        get(pluginId, settingId).pipe(Effect.map((value) => value !== null)),
      clearPlugin: (pluginId) =>
        Ref.update(ref, (all) => {
          if (!(pluginId in all)) return all
          const { [pluginId]: _removed, ...remaining } = all
          return remaining
        })
    }
  })

export const InMemoryPluginSecretStoreLive = Layer.effect(
  PluginSecretStore,
  makeInMemoryPluginSecretStore()
)
