import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

// The app version — single source of truth is this package.json (bumped in
// lockstep by `changeset version`). Inlined into every process as the global
// `__APP_VERSION__` so main, preload and renderer all report the same version
// without reading package.json at runtime.
const { version } = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "package.json"), "utf-8")
)
const define = { __APP_VERSION__: JSON.stringify(version) }

// The `@jingler/*` workspace packages ship raw TypeScript source (their
// `exports` point at `src/*.ts`). Node can't run those directly in the main
// process, so we must NOT externalize them — Vite bundles + transpiles them into
// the main/preload output. Third-party deps (effect, @effect/*, electron) stay
// external and load from node_modules as usual.
const workspacePackages = [
  "@jingler/core",
  "@jingler/contracts",
  "@jingler/cli-adapters",
  "@jingler/themes",
  "@jingler/ui",
  "@jingler/plugin-sdk"
]

export default defineConfig(({ command }) => {
  // Local dev talks to the DEPLOYED auth + team-memory backend (apps/server on
  // Vercel) so the memory features work without running the server locally. The
  // memory service reads `JINGLER_MEMORY_URL ?? JINGLER_AUTH_URL`, and the memory
  // token is minted by signing in against the auth origin — so auth and memory
  // must share one origin. Setting it here (before electron-vite spawns the main
  // process, which inherits this env) points both at prod.
  //
  // `??=`, and dev-only (`serve`): a developer running a fully-local stack can
  // still override by exporting JINGLER_AUTH_URL=http://localhost:9100, and a
  // packaged build is unaffected (it must set the URL at launch).
  if (command === "serve") {
    process.env.JINGLER_AUTH_URL ??= "https://jingler-nine.vercel.app"
  }

  return {
  main: {
    define,
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, "src/main/index.ts"),
          // The extension host runs in its OWN process, so it needs its own
          // bundle — it cannot share main's.
          //
          // The output is `plugin-host-entry.js`, NOT `.mjs`: electron-vite
          // emits main-process entries as `.js` (only the preload gets `.mjs`)
          // and the `.js` is still ESM because this app's own `package.json`
          // declares `"type": "module"`. `plugin-host-bridge.ts` joins that exact
          // filename, and an earlier version of this comment claiming `.mjs`
          // is how it came to fork a path that never existed — the host never
          // booted and every plugin with a `main` half silently failed to
          // activate. Change the name here and that fork breaks again.

          "plugin-host-entry": resolve(
            import.meta.dirname,
            "src/main/plugin-host-entry.ts"
          )
        }
      }
    }
  },
  preload: {
    define,
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, "src/preload/index.ts") }
      }
    }
  },
  renderer: {
    define,
    root: resolve(import.meta.dirname, "src/renderer"),
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, "src/renderer/index.html") }
      }
    }
  }
  }
})
