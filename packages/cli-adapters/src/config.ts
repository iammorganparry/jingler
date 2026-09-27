import type {
  ContextConfig,
  ExecutionMode,
  GitConfig,
  GithubConfig,
  NotificationsConfig,
  OffloadComputeSettings,
  PlanTemplateConfig,
  ProviderConnectionId,
  ProviderModelId,
  JinglerSubagentName,
  SubagentProviderModelAssignments,
  WebSearchConfig,
} from "@jingler/core"
import {
  clampFontScale,
  DEFAULT_THEME_ID,
  ProviderId,
  WEB_SEARCH_CONFIG_DEFAULT,
  WebSearchConfig as WebSearchConfigSchema,
  WorkspaceConfig
} from "@jingler/core"
import { ConfigError } from "@jingler/core"
import { FileSystem } from "@effect/platform"
import { Effect, Either, Schema } from "effect"
import { PlanPrd } from "@jingler/core"
import { AppPaths } from "./app-paths.js"
import { migrateLegacyConfigIdentity } from "./runtime/migration/legacy-runtime-identity.js"

/** Preserve the historical omission rules while copying unrelated settings. */
const preservedSettings = (existing: WorkspaceConfig | null): Partial<WorkspaceConfig> => {
  if (existing === null) return {}
  // Every unrelated section must survive this whole-object read-modify-write.
  const truthyKeys = [
    "context", "github", "git", "starredRepos", "collapsedRepos", "lastRepoPath",
    "defaultConnectionId", "defaultProviderId", "defaultModelId", "defaultMode",
    "subagentModels", "subagentModelsByProvider", "planTemplate", "notifications", "theme", "webSearch", "offloadCompute",
    "disabledPlugins"
  ] as const
  // A saved false (or zero) is a real value, not an absent section.
  const definedKeys = [
    "connectionSelectionRequired", "providerSetupCompleted", "planAutoRun", "adhdMode", "fontScale",
    "subagentDelegationEnabled"
  ] as const
  return Object.fromEntries([
    ...truthyKeys.filter((key) => Boolean(existing[key])).map((key) => [key, existing[key]]),
    ...definedKeys.filter((key) => existing[key] !== undefined).map((key) => [key, existing[key]])
  ])
}

const scopedSubagentAssignments = (
  existing: WorkspaceConfig | null
): SubagentProviderModelAssignments => {
  const scoped: Record<string, Partial<Record<JinglerSubagentName, ProviderModelId>>> =
    Object.fromEntries(Object.entries(existing?.subagentModelsByProvider ?? {}).map(
      ([providerId, assignments]) => [providerId, { ...assignments }]
    ))
  for (const [agent, model] of Object.entries(existing?.subagentModels ?? {})) {
    if (model === undefined) continue
    const providerId = String(model).split("/", 1)[0]!
    scoped[providerId] ??= {}
    scoped[providerId]![agent as JinglerSubagentName] ??= model
  }
  return scoped as SubagentProviderModelAssignments
}

const decodePlanTemplate = Schema.decodeUnknownEither(Schema.parseJson(PlanPrd))

type ConfigEnv = FileSystem.FileSystem | AppPaths

const LegacyReasoningSettings = Schema.Struct({
  reasoningEffort: Schema.optional(Schema.Unknown)
})
const LegacyWebSearchConfig = Schema.Struct({ webSearch: Schema.Unknown })
const LegacyProviderConfig = Schema.Struct({
  providers: Schema.Record({ key: Schema.String, value: Schema.Unknown })
})

const migrateProviderReasoning = (value: unknown): unknown => {
  if (!Schema.is(LegacyReasoningSettings)(value)) return value
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
  if (!Schema.is(LegacyWebSearchConfig)(value)) return value
  return Schema.is(WebSearchConfigSchema)(value.webSearch)
    ? value
    : { ...value, webSearch: WEB_SEARCH_CONFIG_DEFAULT }
}

export const migrateConfigReasoning = (value: unknown): unknown => {
  if (!Schema.is(LegacyProviderConfig)(value)) return value
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
      const writeLock = Effect.runSync(Effect.makeSemaphore(1))
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
        update: Partial<WorkspaceConfig> | ((existing: WorkspaceConfig | null) => Partial<WorkspaceConfig>)
      ): Effect.Effect<WorkspaceConfig, ConfigError, ConfigEnv> =>
        writeLock.withPermits(1)(Effect.gen(function* () {
          const existing = yield* get()
          const createdAt =
            existing?.createdAt ?? (yield* Effect.sync(() => new Date().toISOString()))
          const config: WorkspaceConfig = {
            reposDir: existing?.reposDir ?? null,
            createdAt,
            ...preservedSettings(existing),
            ...(typeof update === "function" ? update(existing) : update)
          }
          return yield* persist(config)
        }))

      const setReposDir = (dir: string) => patch({ reposDir: dir })

      const completeProviderSetup = () => patch({ providerSetupCompleted: true })

      const setGithub = (github: GithubConfig) => patch({ github })

      const setGit = (git: GitConfig) => patch({ git })

      const setNotifications = (notifications: NotificationsConfig) => patch({ notifications })

      /** Permission mode used when creating chats across every provider model. */
      const setDefaultMode = (defaultMode: ExecutionMode) => patch({ defaultMode })

      const setSubagentDelegationEnabled = (subagentDelegationEnabled: boolean) =>
        patch({ subagentDelegationEnabled })

      const setSubagentModel = (
        providerId: ProviderId,
        agent: JinglerSubagentName,
        modelId: ProviderModelId | null
      ) => patch((existing) => {
        const subagentModelsByProvider = {
          ...scopedSubagentAssignments(existing)
        } as Record<string, Partial<Record<JinglerSubagentName, ProviderModelId>>>
        const assignments = { ...(subagentModelsByProvider[providerId] ?? {}) }
        if (modelId === null) delete assignments[agent]
        else assignments[agent] = modelId
        if (Object.keys(assignments).length === 0) delete subagentModelsByProvider[providerId]
        else subagentModelsByProvider[providerId] = assignments
        return { subagentModels: {}, subagentModelsByProvider }
      })

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

      /** Persist only the secret-free WebSearch provider/setup choice. */
      const setWebSearch = (webSearch: WebSearchConfig) => patch({ webSearch })

      /** Replace the set of disabled plugin ids wholesale (PluginRegistry owns the merge). */
      const setDisabledPlugins = (disabledPlugins: ReadonlyArray<string>) =>
        patch({ disabledPlugins })

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
        setSubagentDelegationEnabled,
        setSubagentModel,
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
        setWebSearch,
        setOffloadCompute,
        setDisabledPlugins
      }
    }
  }
) {}
