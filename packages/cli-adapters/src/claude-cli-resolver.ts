import { access, constants } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { loginShellEnvironment } from "./login-shell-env.js"

/** Directories Homebrew/manual installs use that a GUI-launched Electron app's PATH may miss. */
const fallbackDirectories = (home: string): ReadonlyArray<string> => [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  join(home, ".local", "bin"),
  join(home, ".claude", "local")
]

export interface ClaudeCliResolverDeps {
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly homeDir?: string
  readonly fileExists?: (path: string) => Promise<boolean>
  readonly loginShellEnv?: typeof loginShellEnvironment
}

const defaultFileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const findOnPath = async (
  name: string,
  pathValue: string | undefined,
  fileExists: (path: string) => Promise<boolean>
): Promise<string | null> => {
  if (!pathValue) return null
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name)
    if (await fileExists(candidate)) return candidate
  }
  return null
}

const findInDirectories = async (
  name: string,
  directories: ReadonlyArray<string>,
  fileExists: (path: string) => Promise<boolean>
): Promise<string | null> => {
  for (const dir of directories) {
    const candidate = join(dir, name)
    if (await fileExists(candidate)) return candidate
  }
  return null
}

interface SearchContext {
  readonly processPath: string | undefined
  readonly loginPath: () => Promise<string | undefined>
  readonly directories: ReadonlyArray<string>
  readonly fileExists: (path: string) => Promise<boolean>
}

/** Every source for one binary name, in resolver order. */
const searchForName = async (name: string, context: SearchContext): Promise<string | null> => {
  const onProcessPath = await findOnPath(name, context.processPath, context.fileExists)
  if (onProcessPath) return onProcessPath
  const onLoginPath = await findOnPath(name, await context.loginPath(), context.fileExists)
  if (onLoginPath) return onLoginPath
  return findInDirectories(name, context.directories, context.fileExists)
}

/** Loads the login-shell PATH at most once, no matter how many names are searched. */
const memoizedLoginPath = (
  loginShellEnv: typeof loginShellEnvironment,
  shell: string | undefined,
  platform: NodeJS.Platform
): (() => Promise<string | undefined>) => {
  let cached: Promise<string | undefined> | undefined
  return () => {
    cached ??= loginShellEnv(shell, platform).then((env) => env.PATH)
    return cached
  }
}

/**
 * Finds the Claude CLI binary, trying every known install location in order.
 * A GUI-launched Electron app doesn't inherit the operator's login-shell
 * PATH, so a Homebrew (`/opt/homebrew/bin`) or `hsclaude`-wrapped install is
 * otherwise invisible. Every caller (connector import, CLI provider,
 * endpoint probe, agent runtime) resolves through this instead of assuming
 * `claude` is already on `process.env.PATH`.
 *
 * Order: explicit override (option, then `JINGLER_CLAUDE_BINARY`) → current
 * process PATH → login-shell PATH → Homebrew/manual-install fallback
 * directories — each tried for `claude` first, then for the `hsclaude`
 * wrapper. Falls back to the bare `"claude"` name so existing ENOENT
 * handling still reports a clear "not found" message.
 */
export const resolveClaudeBinary = async (
  explicit: string | undefined,
  deps: ClaudeCliResolverDeps = {}
): Promise<string> => {
  if (explicit) return explicit
  const env = deps.env ?? process.env
  if (env.JINGLER_CLAUDE_BINARY) return env.JINGLER_CLAUDE_BINARY

  const context: SearchContext = {
    processPath: env.PATH,
    loginPath: memoizedLoginPath(deps.loginShellEnv ?? loginShellEnvironment, env.SHELL, deps.platform ?? process.platform),
    directories: fallbackDirectories(deps.homeDir ?? homedir()),
    fileExists: deps.fileExists ?? defaultFileExists
  }

  for (const name of ["claude", "hsclaude"]) {
    const found = await searchForName(name, context)
    if (found) return found
  }
  return "claude"
}
