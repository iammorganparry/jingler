import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { makeAppPaths } from "./app-paths-factory.js"

describe("makeAppPaths", () => {
  it("derives the complete runtime layout from one root", () => {
    const root = join("", "tmp", "jingler")

    expect(makeAppPaths(root)).toEqual({
      root,
      configFile: join(root, "config.json"),
      mcpConfigFile: join(root, "mcp.json"),
      sessionsFile: join(root, "sessions.json"),
      projectsFile: join(root, "projects.json"),
      routinesFile: join(root, "routines.json"),
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
      diagnosticsDir: join(root, "runtime", "diagnostics")
    })
  })

  it("allows a runtime to override only exceptional locations", () => {
    const root = join("", "tmp", "jingler")
    const builtinPluginsDir = join("", "opt", "jingler", "plugins")

    expect(makeAppPaths(root, { builtinPluginsDir })).toMatchObject({
      root,
      pluginsDir: join(root, "plugins"),
      builtinPluginsDir
    })
  })
})
