import type {
  ContextConfig,
  ExecutionMode,
  GitConfig,
  GithubConfig,
  MemoryConfig,
  NotificationsConfig,
  OpenConnectorConfig,
  OffloadComputeSettings,
  PlanTemplateConfig,
  ProviderConnectionId,
  ProviderId,
  ProviderModelId,
  WebSearchConfig,
} from "@jingler/core"
import {
  clampFontScale,
  DEFAULT_THEME_ID,
  WEB_SEARCH_CONFIG_DEFAULT,
  WorkspaceConfig
} from "@jingler/core"
import { ConfigError } from "@jingler/core"
import { FileSystem } from "@effect/platform"
import { Effect, Either, Schema } from "effect"
import { PlanPrd } from "@jingler/core"
import { AppPaths } from "./app-paths.js"
import { migrateLegacyConfigIdentity } from "./runtime/migration/legacy-runtime-identity.js"

const decodePlanTemplate = Schema.decodeUnknownEither(Schema.parseJson(PlanPrd))

type ConfigEnv = FileSystem.FileSystem | AppPaths

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const migrateProviderReasoning = (value: unknown): unknown => {
  if (!isRecord(value)) return value
  switch (value.reasoningEffort) {
    case "off":
      return { ...value, thinkingEnabled: false, reasoningEffort: undefined }
    case "think":
      return { ...value, thinkingEnabled: true, reasoningEffort: "low" }
    case "think-hard":
      return { ...value, thinkingEnabled: true, reasoningEffort: "high" }
    case "ultrathink":
      return { ...value, thinkingEnabled: true, reasoningEffort: "xhigh" }
    default:
      return value
  }
}

export const migrateConfigWebSearch = (value: unknown): unknown => {
  if (!isRecord(value) || !("webSearch" in value)) return value
  const webSearch = value.webSearch
  if (!isRecord(webSearch)) {
    return { ...value, webSearch: WEB_SEARCH_CONFIG_DEFAULT }
  }
  const provider = webSearch.provider
  const validProvider = provider === "exa" || provider === "firecrawl"
  const valid =
    (webSearch.setup === "pending" && (provider === null || validProvider)) ||
    (webSearch.setup === "skipped" && provider === null) ||
    (webSearch.setup === "configured" && validProvider)
  return valid ? value : { ...value, webSearch: WEB_SEARCH_CONFIG_DEFAULT }
}

export const migrateConfigReasoning = (value: unknown): unknown => {
  if (!(isRecord(value) && isRecord(value.providers))) return value
  return {
    ...value,
    providers: Object.fromEntries(
      Object.entries(value.providers).map(([cli, provider]) => [
        cli,
        migrateProviderReasoning(provider)
      ])
    )
  }
}

/**
 * Reads and writes the persisted `WorkspaceConfig` at `~/jingler/config.json`.
 * `get()` returns null until first-run setup writes a repos directory. Backed by
 * `@effect/platform` `FileSystem` (from `NodeContext.layer`) + `AppPaths`.
 */
export class ConfigService extends Effect.Service<ConfigService>()(
  "@jingler/ConfigService",
  {
    accessors: true,
    sync: () => {
      const get = (): Effect.Effect<WorkspaceConfig | null, ConfigError, ConfigEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const paths = yield* AppPaths
          const exists = yield* fs
            .exists(paths.configFile)
            .pipe(Effect.orElseSucceed(() => false))
          if (!exists) return null
          const raw = yield* fs
            .readFileString(paths.configFile)
            .pipe(Effect.mapError((cause) => new ConfigError({ message: "Failed to read config", cause })))
          const parsed = yield* Schema.decodeUnknown(Schema.parseJson(Schema.Unknown))(raw).pipe(
            Effect.mapError((cause) => new ConfigError({ message: "Config file is malformed", cause }))
          )
          return yield* Schema.decodeUnknown(WorkspaceConfig)(
            migrateLegacyConfigIdentity(
              migrateConfigWebSearch(migrateConfigReasoning(parsed))
            )
          ).pipe(
            Effect.mapError(
              (cause) => new ConfigError({ message: "Config file is malformed", cause })
            )
          )
        })

      /**
       * Apply `patch` on top of the persisted config, preserving every other
       * section (so saving one lever never drops another). Seeds `createdAt` +
       * a null `reposDir` on first write.
       */
      const patch = (
        patch: Partial<WorkspaceConfig>
      ): Effect.Effect<WorkspaceConfig, ConfigError, ConfigEnv> =>
        Effect.gen(function* () {
          const existing = yield* get()
          const createdAt =
            existing?.createdAt ?? (yield* Effect.sync(() => new Date().toISOString()))
          const config: WorkspaceConfig = {
            reposDir: existing?.reposDir ?? null,
            createdAt,
            ...(existing?.context ? { context: existing.context } : {}),
            ...(existing?.github ? { github: existing.github } : {}),
            ...(existing?.git ? { git: existing.git } : {}),
            ...(existing?.starredRepos ? { starredRepos: existing.starredRepos } : {}),
            ...(existing?.collapsedRepos ? { collapsedRepos: existing.collapsedRepos } : {}),
            ...(existing?.lastRepoPath ? { lastRepoPath: existing.lastRepoPath } : {}),
            ...(existing?.defaultConnectionId
              ? { defaultConnectionId: existing.defaultConnectionId }
              : {}),
            ...(existing?.defaultProviderId
              ? { defaultProviderId: existing.defaultProviderId }
              : {}),
            ...(existing?.defaultModelId ? { defaultModelId: existing.defaultModelId } : {}),
            ...(existing?.defaultMode ? { defaultMode: existing.defaultMode } : {}),
            ...(existing?.connectionSelectionRequired !== undefined
              ? { connectionSelectionRequired: existing.connectionSelectionRequired }
              : {}),
            ...(existing?.providerSetupCompleted !== undefined
              ? { providerSetupCompleted: existing.providerSetupCompleted }
              : {}),
            ...(existing?.planTemplate ? { planTemplate: existing.planTemplate } : {}),
            ...(existing?.notifications ? { notifications: existing.notifications } : {}),
            // Booleans are checked against `undefined`, not truthiness — a saved
            // `false` is a real setting and must survive an unrelated write.
            ...(existing?.planAutoRun !== undefined ? { planAutoRun: existing.planAutoRun } : {}),
            ...(existing?.adhdMode !== undefined ? { adhdMode: existing.adhdMode } : {}),
            ...(existing?.fontScale !== undefined ? { fontScale: existing.fontScale } : {}),
            ...(existing?.theme ? { theme: existing.theme } : {}),
            ...(existing?.openConnector ? { openConnector: existing.openConnector } : {}),
            ...(existing?.webSearch ? { webSearch: existing.webSearch } : {}),
            ...(existing?.memory ? { memory: existing.memory } : {}),
            ...(existing?.offloadCompute ? { offloadCompute: existing.offloadCompute } : {}),
            ...(existing?.disabledPlugins ? { disabledPlugins: existing.disabledPlugins } : {}),
            // MANDATORY: omit a section here and every unrelated save silently
            // drops it, because `patch` is a whole-object read-modify-write.
            ...patch
          }
          return yield* persist(config)
        })

      const setReposDir = (dir: string) => patch({ reposDir: dir })

      const completeProviderSetup = () => patch({ providerSetupCompleted: true })

      const setGithub = (github: GithubConfig) => patch({ github })

      const setGit = (git: GitConfig) => patch({ git })

      const setNotifications = (notifications: NotificationsConfig) => patch({ notifications })

      /** Permission mode used when creating chats across every provider model. */
      const setDefaultMode = (defaultMode: ExecutionMode) => patch({ defaultMode })

      /** Whether plan mode runs its (read-only) commands without asking. */
      const setPlanAutoRun = (planAutoRun: boolean) => patch({ planAutoRun })

      /** Whether final completion summaries are shaped for an ADHD reader. */
      const setAdhdMode = (adhdMode: boolean) => patch({ adhdMode })

      /**
       * Conversation + code text-size multiplier, clamped via the shared
       * `clampFontScale` so the stored value can never scale the transcript to
       * zero or off-screen — the same guard the read path uses.
       */
      const setFontScale = (fontScale: number) => patch({ fontScale: clampFontScale(fontScale) })

      const setStarredRepos = (starredRepos: ReadonlyArray<string>) =>
        patch({ starredRepos })

      const setCollapsedRepos = (collapsedRepos: ReadonlyArray<string>) =>
        patch({ collapsedRepos })

      const setLastRepoPath = (lastRepoPath: string) => patch({ lastRepoPath })

      /** Save the auto-compaction levers (master switch + working-set budget). */
      const setContext = (context: ContextConfig) => patch({ context })

      /** Persist the starting plan structure (a JSON PlanPrd; empty = built-in default). */
      const setPlanTemplate = (planTemplate: PlanTemplateConfig) => {
        if (planTemplate.source.trim().length === 0) return patch({ planTemplate })
        const result = decodePlanTemplate(planTemplate.source)
        return Either.isRight(result)
          ? patch({ planTemplate })
          : Effect.fail(
              new ConfigError({
                message: "Plan template is not a valid structured plan (JSON PlanPrd)."
              })
            )
      }

      /** Persist the canonical runtime selection as one indivisible config update. */
      const setDefaultProviderModel = (
        defaultConnectionId: ProviderConnectionId,
        defaultProviderId: ProviderId,
        defaultModelId: ProviderModelId
      ) =>
        patch({
          defaultConnectionId,
          defaultProviderId,
          defaultModelId,
          connectionSelectionRequired: false
        })

      /**
       * Switch the active colour theme, preserving any `colorCustomizations`
       * the operator has layered on top.
       *
       * Preserving rather than clearing because the overrides are keyed by VS
       * Code colour name, not by theme — "I always want a louder focus ring"
       * survives trying out a different theme, which is the whole reason the
       * override layer is separate from the theme file in the first place.
       */
      const setActiveTheme = (activeId: string) =>
        Effect.gen(function* () {
          const existing = yield* get()
          return yield* patch({
            theme: {
              activeId,
              ...(existing?.theme?.colorCustomizations
                ? { colorCustomizations: existing.theme.colorCustomizations }
                : {})
            }
          })
        })

      /** Persist the unified OpenConnector settings (endpoint, toggles). Token is NOT here. */
      const setOpenConnector = (openConnector: OpenConnectorConfig) => patch({ openConnector })

      /** Persist only the secret-free WebSearch provider/setup choice. */
      const setWebSearch = (webSearch: WebSearchConfig) => patch({ webSearch })

      /** Replace the set of disabled plugin ids wholesale (PluginRegistry owns the merge). */
      const setDisabledPlugins = (disabledPlugins: ReadonlyArray<string>) =>
        patch({ disabledPlugins })

      /** Save only renderer-safe memory enablement and organization selection. */
      const setMemory = (memory: MemoryConfig) => patch({ memory })

      /** Persist automatic compute routing and its shell-free project allowlist. */
      const setOffloadCompute = (offloadCompute: OffloadComputeSettings) =>
        patch({ offloadCompute })

      /** Replace the override layer wholesale, keeping the active theme id. */
      const setThemeCustomizations = (colorCustomizations: Record<string, string>) =>
        Effect.gen(function* () {
          const existing = yield* get()
          return yield* patch({
            theme: {
              activeId: existing?.theme?.activeId ?? DEFAULT_THEME_ID,
              colorCustomizations
            }
          })
        })

      /** Encode + write the config to disk, mapping every failure to `ConfigError`. */
      const persist = (config: WorkspaceConfig): Effect.Effect<WorkspaceConfig, ConfigError, ConfigEnv> =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const paths = yield* AppPaths
          yield* fs
            .makeDirectory(paths.root, { recursive: true })
            .pipe(Effect.mapError((cause) => new ConfigError({ message: "Failed to create ~/jingler", cause })))
          const encoded = yield* Schema.encode(WorkspaceConfig)(config).pipe(
            Effect.mapError((cause) => new ConfigError({ message: "Failed to encode config", cause }))
          )
          yield* fs
            .writeFileString(paths.configFile, JSON.stringify(encoded, null, 2))
            .pipe(Effect.mapError((cause) => new ConfigError({ message: "Failed to write config", cause })))
          return config
        })

      return {
        get,
        setReposDir,
        completeProviderSetup,
        setGithub,
        setGit,
        setNotifications,
        setDefaultMode,
        setPlanAutoRun,
        setAdhdMode,
        setFontScale,
        setStarredRepos,
        setCollapsedRepos,
        setLastRepoPath,
        setContext,
        setDefaultProviderModel,
        setPlanTemplate,
        setActiveTheme,
        setThemeCustomizations,
        setOpenConnector,
        setWebSearch,
        setMemory,
        setOffloadCompute,
        setDisabledPlugins
      }
    }
  }
) {}
