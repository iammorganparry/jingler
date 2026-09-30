import { nativeCliEnvironment, withMacCliPath } from "./native-cli-environment.js"

export const withClaudeCliPath = (
  environment: NodeJS.ProcessEnv,
  platform = process.platform
): NodeJS.ProcessEnv => withMacCliPath(environment, platform)

export const claudeCliEnvironment = (
  environment: NodeJS.ProcessEnv,
  platform = process.platform
): NodeJS.ProcessEnv => nativeCliEnvironment(withClaudeCliPath(environment, platform))
