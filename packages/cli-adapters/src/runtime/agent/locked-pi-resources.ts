import {
  DefaultResourceLoader,
  SettingsManager,
  type ResourceLoader
} from "@earendil-works/pi-coding-agent"
import { Data, Effect } from "effect"
import { PI_SUBAGENTS_EXTENSION_PATH } from "../subagents/pi-subagents-bootstrap.js"

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
        additionalExtensionPaths: [PI_SUBAGENTS_EXTENSION_PATH],
        additionalSkillPaths: [],
        additionalPromptTemplatePaths: [],
        additionalThemePaths: [],
        extensionFactories: [],
        systemPromptOverride: () => input.systemPrompt,
        appendSystemPromptOverride: () => [],
        extensionsOverride: (base) => ({
          ...base,
          extensions: base.extensions.filter(
            (extension) => extension.resolvedPath === PI_SUBAGENTS_EXTENSION_PATH
          )
        }),
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
): Effect.Effect<void, PiResourceError> => {
  const inventory: ReadonlyArray<readonly [string, boolean]> = [
    ["system prompt", loader.getSystemPrompt() === expectedPrompt],
    ["appended prompt", loader.getAppendSystemPrompt().length === 0],
    [
      "extension",
      loader.getExtensions().extensions.length === 1 &&
        loader.getExtensions().extensions[0]?.resolvedPath ===
          PI_SUBAGENTS_EXTENSION_PATH &&
        loader.getExtensions().errors.length === 0
    ],
    ["skill", loader.getSkills().skills.length === 0],
    ["prompt template", loader.getPrompts().prompts.length === 0],
    ["theme", loader.getThemes().themes.length === 0],
    ["context file", loader.getAgentsFiles().agentsFiles.length === 0]
  ]
  const violations = inventory.flatMap(([name, valid]) => valid ? [] : [name])
  return violations.length === 0
    ? Effect.void
    : Effect.fail(
        new PiResourceError({
          message: `Ambient pi resources escaped containment: ${violations.join(", ")}`
        })
      )
}
