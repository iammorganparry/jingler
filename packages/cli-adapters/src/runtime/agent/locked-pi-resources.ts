import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createRequire } from "node:module"
import {
  DefaultResourceLoader,
  SettingsManager,
  type EventBus,
  type ResourceLoader
} from "@earendil-works/pi-coding-agent"
import { Data, Effect } from "effect"
import { PI_SUBAGENTS_EXTENSION_PATH } from "../subagents/pi-subagents-bootstrap.js"
import {
  PONYTAIL_EXTENSION_PATH,
  PONYTAIL_SKILLS_PATH
} from "../resources/ponytail-resources.js"
export { PONYTAIL_EXTENSION_PATH, PONYTAIL_SKILLS_PATH } from "../resources/ponytail-resources.js"

const require = createRequire(import.meta.url)
export const PLANNOTATOR_EXTENSION_PATH = dirname(
  require.resolve("@plannotator/pi-extension/package.json")
)

const ALLOWED_EXTENSION_PATHS = new Set([
  PI_SUBAGENTS_EXTENSION_PATH,
  PONYTAIL_EXTENSION_PATH,
  PLANNOTATOR_EXTENSION_PATH
])

export class PiResourceError extends Data.TaggedError("PiResourceError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface LockedPiResourceInput {
  readonly cwd: string
  readonly agentDir: string
  readonly systemPrompt: string
  readonly eventBus?: EventBus
  readonly plannotatorExecutionTools?: ReadonlyArray<string>
}

/** Build a pi loader whose only prompt/resource input is supplied by Jingler. */
export const createLockedPiResources = (
  input: LockedPiResourceInput
): Effect.Effect<ResourceLoader, PiResourceError> =>
  Effect.tryPromise({
    try: async () => {
      if (input.plannotatorExecutionTools !== undefined) {
        await mkdir(input.agentDir, { recursive: true })
        await writeFile(
          join(input.agentDir, "plannotator.json"),
          JSON.stringify({
            executionMode: "automatic",
            phases: {
              executing: { activeTools: input.plannotatorExecutionTools }
            }
          })
        )
      }
      const loader = new DefaultResourceLoader({
        cwd: input.cwd,
        agentDir: input.agentDir,
        ...(input.eventBus ? { eventBus: input.eventBus } : {}),
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
        additionalExtensionPaths: [
          PI_SUBAGENTS_EXTENSION_PATH,
          PONYTAIL_EXTENSION_PATH,
          PLANNOTATOR_EXTENSION_PATH
        ],
        additionalSkillPaths: [PONYTAIL_SKILLS_PATH],
        additionalPromptTemplatePaths: [],
        additionalThemePaths: [],
        extensionFactories: [],
        systemPromptOverride: () => input.systemPrompt,
        appendSystemPromptOverride: () => [],
        extensionsOverride: (base) => ({
          ...base,
          extensions: base.extensions.filter((extension) =>
            ALLOWED_EXTENSION_PATHS.has(extension.resolvedPath)
          )
        }),
        skillsOverride: (base) => ({
          ...base,
          skills: base.skills.filter((skill) => skill.filePath.startsWith(PONYTAIL_SKILLS_PATH))
        }),
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
      loader.getExtensions().extensions.length === ALLOWED_EXTENSION_PATHS.size &&
        loader.getExtensions().extensions.every((extension) =>
          ALLOWED_EXTENSION_PATHS.has(extension.resolvedPath)
        ) &&
        loader.getExtensions().errors.length === 0
    ],
    [
      "skill",
      loader.getSkills().skills.length > 0 &&
        loader.getSkills().skills.every((skill) => skill.filePath.startsWith(PONYTAIL_SKILLS_PATH))
    ],
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
