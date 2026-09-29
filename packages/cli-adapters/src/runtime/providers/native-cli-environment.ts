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

export const nativeCliEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    allowedEnvironment.flatMap((key) =>
      environment[key] === undefined ? [] : [[key, environment[key]]]
    )
  )
