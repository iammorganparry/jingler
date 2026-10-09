import { randomBytes } from "node:crypto"
import { execFileText } from "./child-registry.js"

let cached: Promise<Readonly<Record<string, string>>> | undefined

/** Parse `env -0` output: NUL-separated `KEY=value` pairs (values may hold newlines). */
export const parseEnvNul = (output: string): Record<string, string> =>
  Object.fromEntries(output.split("\0").flatMap((pair) => {
    const eq = pair.indexOf("=")
    return eq > 0 ? [[pair.slice(0, eq), pair.slice(eq + 1)]] : []
  }))

/** The env block between two markers, ignoring whatever startup files print around it. */
export const framedEnv = (output: string, marker: string): Record<string, string> => {
  const start = output.indexOf(marker)
  const end = output.lastIndexOf(marker)
  return start < 0 || end <= start ? {} : parseEnvNul(output.slice(start + marker.length, end))
}

/**
 * The operator's interactive login-shell environment, read once per app run.
 *
 * Electron launched from Finder/Dock gets a minimal PATH and none of the
 * operator's shell exports. `-i` is needed too: zsh only reads `.zshrc`
 * (where nvm and most credential exports live) for interactive shells.
 * Startup files may print, so the env is framed by a random marker. Any
 * failure (no shell, slow profile, Windows) yields `{}`.
 */
export const loginShellEnvironment = (
  shell = process.env.SHELL,
  platform = process.platform
): Promise<Readonly<Record<string, string>>> => {
  if (platform === "win32" || !shell) return Promise.resolve({})
  cached ??= (() => {
    const marker = `__JINGLER_ENV_${randomBytes(8).toString("hex")}__`
    return execFileText(shell, ["-ilc", `printf '%s' ${marker}; env -0; printf '%s' ${marker}`], {
      timeout: 5_000,
      maxBuffer: 1_048_576
    }).then((output) => framedEnv(output, marker), () => ({}))
  })()
  return cached
}
