import { delimiter } from "node:path"
import { loginShellEnvironment } from "../../login-shell-env.js"

const macSystemDirectories = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] as const
const macCliDirectories = ["/opt/homebrew/bin", "/usr/local/bin"] as const

/**
 * Proxy, CA and mTLS settings (https://code.claude.com/docs/en/network-config).
 * Behind a TLS-inspecting proxy, dropping these turns every CLI request into a bare "fetch failed".
 */
const networkEnvironment = [
  "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "CLAUDE_CODE_CERT_STORE",
  "CLAUDE_CODE_CLIENT_CERT", "CLAUDE_CODE_CLIENT_KEY", "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE"
] as const

/** Fill network settings the app process lacks (Dock launches skip shell exports) from the login shell. */
export const withLoginShellNetwork = async (
  environment: NodeJS.ProcessEnv,
  shellEnvironment: () => Promise<Readonly<Record<string, string>>> = loginShellEnvironment
): Promise<NodeJS.ProcessEnv> => {
  const missing = networkEnvironment.filter((key) => environment[key] === undefined)
  if (missing.length === 0) return environment
  const shell = await shellEnvironment()
  return { ...environment, ...Object.fromEntries(missing.flatMap((key) => shell[key] === undefined ? [] : [[key, shell[key]]])) }
}

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
  "WINDIR",
  ...networkEnvironment
] as const

export const withMacCliPath = (
  environment: NodeJS.ProcessEnv,
  platform = process.platform
): NodeJS.ProcessEnv => {
  if (platform !== "darwin") return { ...environment }
  const entries = environment.PATH === undefined
    ? [...macSystemDirectories]
    : environment.PATH.split(delimiter).filter(Boolean)
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
