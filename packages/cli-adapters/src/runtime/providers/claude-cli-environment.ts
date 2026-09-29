import { delimiter } from "node:path"
import { nativeCliEnvironment } from "./native-cli-environment.js"

const macCliDirectories = ["/opt/homebrew/bin", "/usr/local/bin"] as const

export const withClaudeCliPath = (
  environment: NodeJS.ProcessEnv,
  platform = process.platform
): NodeJS.ProcessEnv => {
  if (platform !== "darwin") return { ...environment }
  const entries = (environment.PATH ?? "").split(delimiter).filter(Boolean)
  return {
    ...environment,
    PATH: [...entries, ...macCliDirectories.filter((entry) => !entries.includes(entry))].join(delimiter)
  }
}

export const claudeCliEnvironment = (
  environment: NodeJS.ProcessEnv,
  platform = process.platform
): NodeJS.ProcessEnv => nativeCliEnvironment(withClaudeCliPath(environment, platform))
