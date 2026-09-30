import { delimiter } from "node:path"

const macCliDirectories = ["/opt/homebrew/bin", "/usr/local/bin"] as const

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

export const withMacCliPath = (
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

export const nativeCliEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    allowedEnvironment.flatMap((key) =>
      environment[key] === undefined ? [] : [[key, environment[key]]]
    )
  )
