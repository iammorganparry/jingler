import { join } from "node:path"
import type { AppPathsShape } from "./app-paths.js"

export type AppPathsOverrides = Readonly<Partial<Omit<AppPathsShape, "root">>>

/**
 * Resolve every Jingler-owned path from one root. Runtime-specific callers may
 * override exceptional locations (for example Electron's bundled plugins),
 * while local and remote runtimes continue to share this source of truth.
 *
 * This Node-only factory is intentionally separate from the browser-safe
 * `AppPaths` service tag, because the renderer consumes cli-adapters' barrel.
 */
export const makeAppPaths = (
  root: string,
  overrides: AppPathsOverrides = {}
): AppPathsShape => ({
  root,
  configFile: join(root, "config.json"),
  mcpConfigFile: join(root, "mcp.json"),
  sessionsFile: join(root, "sessions.json"),
  projectsFile: join(root, "projects.json"),
  worktreesDir: join(root, "worktrees"),
  transcriptsDir: join(root, "transcripts"),
  reviewsDir: join(root, "reviews"),
  plansDir: join(root, ".jingler"),
  themesDir: join(root, "themes"),
  pluginsDir: join(root, "plugins"),
  pluginStorageDir: join(root, "plugin-storage"),
  authFile: join(root, "auth.enc"),
  openConnectorFile: join(root, "open-connector.enc"),
  deviceIdentityFile: join(root, "device", "identity.json"),
  deviceSecretsFile: join(root, "device", "provider-secrets.enc"),
  piSessionsDir: join(root, "pi-sessions"),
  managedResourcesDir: join(root, "agent-resources"),
  importedMcpFile: join(root, "agent-resources", "mcp.json"),
  certificationsFile: join(root, "runtime", "certifications.json"),
  providerConnectionsFile: join(root, "runtime", "provider-connections.json"),
  runJournalsDir: join(root, "runtime", "journals"),
  diagnosticsDir: join(root, "runtime", "diagnostics"),
  ...overrides
})
