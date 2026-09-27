import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import { skillBody } from "./skill-metadata.js"
import { dirname, resolve } from "node:path"
import type { AgentRunSpec } from "@jingler/core"
import type { PromptLayer } from "../prompt/prompt-compiler.js"

const require = createRequire(import.meta.url)
const ponytailRoot = resolve(dirname(require.resolve("@dietrichgebert/ponytail")), "../..")

export const PONYTAIL_VERSION = "4.9.0"
export const PONYTAIL_EXTENSION_PATH = resolve(ponytailRoot, "pi-extension/index.js")
export const PONYTAIL_SKILLS_PATH = resolve(ponytailRoot, "skills")

export type PonytailMode = NonNullable<AgentRunSpec["ponytailMode"]>
export const ponytailConfig = require(resolve(ponytailRoot, "hooks/ponytail-config.js")) as {
  getDefaultMode(): PonytailMode
  normalizePersistedMode(value: string): PonytailMode | null
  isDeactivationCommand(text: string): boolean
  writeDefaultMode(mode: PonytailMode): string | null
}
const instructions = require(resolve(ponytailRoot, "hooks/ponytail-instructions.js")) as {
  getPonytailInstructions(mode: PonytailMode): string
}

export const ponytailPromptLayers = (mode: AgentRunSpec["ponytailMode"]): ReadonlyArray<PromptLayer> =>
  mode === undefined || mode === "off" ? [] : [{
    id: "jingler.ponytail", kind: "preferences", trust: "trusted", required: true,
    version: PONYTAIL_VERSION,
    content: mode === "review"
      ? `${instructions.getPonytailInstructions(mode)}\n\n${skillBody(readFileSync(resolve(PONYTAIL_SKILLS_PATH, "ponytail-review/SKILL.md"), "utf8"))}`
      : instructions.getPonytailInstructions(mode)
  }]
