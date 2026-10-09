import { execFile } from "node:child_process"

let cached: Promise<Readonly<Record<string, string>>> | undefined

/** Parse `env -0` output: NUL-separated `KEY=value` pairs (values may hold newlines). */
export const parseEnvNul = (output: string): Record<string, string> =>
  Object.fromEntries(output.split("\0").flatMap((pair) => {
    const eq = pair.indexOf("=")
    return eq > 0 ? [[pair.slice(0, eq), pair.slice(eq + 1)]] : []
  }))

/**
 * The operator's login-shell environment, read once per app run.
 *
 * Electron launched from Finder/Dock gets a minimal PATH and none of the
 * operator's shell exports, so a stdio MCP server that works from a terminal
 * fails to spawn here. Any failure (no shell, slow profile, Windows) yields `{}`.
 */
export const loginShellEnvironment = (
  shell = process.env.SHELL,
  platform = process.platform
): Promise<Readonly<Record<string, string>>> => {
  if (platform === "win32" || !shell) return Promise.resolve({})
  cached ??= new Promise((resolve) => {
    execFile(shell, ["-lc", "env -0"], { timeout: 5_000, maxBuffer: 1_048_576 }, (error, stdout) =>
      resolve(error ? {} : parseEnvNul(stdout)))
  })
  return cached
}
