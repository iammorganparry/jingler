import {
  DefaultResourceLoader,
  SettingsManager,
  type ResourceLoader
} from "@earendil-works/pi-coding-agent"
import { Data, Effect } from "effect"

export class PiResourceError extends Data.TaggedError("PiResourceError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface LockedPiResourceInput {
  readonly cwd: string
  readonly agentDir: string
  readonly systemPrompt: string
}

/** Build a pi loader whose only prompt/resource input is supplied by Jingler. */
export const createLockedPiResources = (
  input: LockedPiResourceInput
): Effect.Effect<ResourceLoader, PiResourceError> =>
  Effect.tryPromise({
    try: async () => {
      const loader = new DefaultResourceLoader({
        cwd: input.cwd,
        agentDir: input.agentDir,
        settingsManager: SettingsManager.inMemory({
          packages: [],
          extensions: [],
          skills: [],
          prompts: [],
          themes: []
        }),
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        additionalExtensionPaths: [],
        additionalSkillPaths: [],
        additionalPromptTemplatePaths: [],
        additionalThemePaths: [],
        extensionFactories: [],
        systemPromptOverride: () => input.systemPrompt,
        appendSystemPromptOverride: () => [],
        extensionsOverride: (base) => ({ ...base, extensions: [] }),
        skillsOverride: () => ({ skills: [], diagnostics: [] }),
        promptsOverride: () => ({ prompts: [], diagnostics: [] }),
        themesOverride: () => ({ themes: [], diagnostics: [] }),
        agentsFilesOverride: () => ({ agentsFiles: [] })
      })
      await loader.reload()
      return loader
    },
    catch: (cause) =>
      new PiResourceError({
        message: "Failed to create locked pi resources",
        cause
      })
  })

export const assertLockedPiResources = (
  loader: ResourceLoader,
  expectedPrompt: string
): Effect.Effect<void, PiResourceError> =>
  Effect.gen(function* () {
    const violations = [
      loader.getSystemPrompt() === expectedPrompt ? null : "system prompt",
      loader.getAppendSystemPrompt().length === 0 ? null : "appended prompt",
      loader.getExtensions().extensions.length === 0 ? null : "extension",
      loader.getSkills().skills.length === 0 ? null : "skill",
      loader.getPrompts().prompts.length === 0 ? null : "prompt template",
      loader.getThemes().themes.length === 0 ? null : "theme",
      loader.getAgentsFiles().agentsFiles.length === 0 ? null : "context file"
    ].filter((value): value is string => value !== null)
    if (violations.length > 0) {
      return yield* Effect.fail(
        new PiResourceError({
          message: `Ambient pi resources escaped containment: ${violations.join(", ")}`
        })
      )
    }
  })
