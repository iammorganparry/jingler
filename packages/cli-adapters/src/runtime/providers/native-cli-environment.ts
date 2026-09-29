import { delimiter } from "node:path"

const allowedEnvironment = [
  "APPDATA",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "LOGNAME",
  "PATH",
  "SHELL",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "WINDIR"
] as const

const macCliDirectories = ["/opt/homebrew/bin", "/usr/local/bin"] as const

export const withNativeCliPath = (
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

export const nativeCliEnvironment = (
  environment: NodeJS.ProcessEnv,
  platform = process.platform
): NodeJS.ProcessEnv => {
  const normalized = withNativeCliPath(environment, platform)
  return Object.fromEntries(
    allowedEnvironment.flatMap((key) =>
      normalized[key] === undefined ? [] : [[key, normalized[key]]]
    )
  )
}
