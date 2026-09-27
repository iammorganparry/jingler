import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

// The app version — single source of truth is this package.json (bumped in
// lockstep by `changeset version`). Inlined into every process as the global
// `__APP_VERSION__` so main, preload and renderer all report the same version
// without reading package.json at runtime.
const { version } = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "package.json"), "utf-8")
)
const define = { __APP_VERSION__: JSON.stringify(version) }
// Resolve the diffs worker the way Node would resolve @pierre/diffs from this
// app: nearest node_modules first, walking up. apps/desktop declares
// @pierre/diffs directly (at the version packages/ui pins) precisely so this
// walk finds the renderer's own copy wherever the hoisted linker placed it —
// a worker from a different install (the Plannotator extension pins its own
// @pierre/diffs) under the renderer's main-thread copy is protocol roulette.
// The package is ESM-only with no ./package.json export, so createRequire
// cannot do this walk for us. electron.vite.config.test.ts pins the resolved
// worker's version to the declared one.
const findPierreDiffsWorker = (): string => {
  let dir = import.meta.dirname
  while (true) {
    const candidate = resolve(dir, "node_modules/@pierre/diffs/dist/worker/worker.js")
    if (existsSync(candidate)) return candidate
    const parent = resolve(dir, "..")
    if (parent === dir) throw new Error("@pierre/diffs worker.js not found in any node_modules")
    dir = parent
  }
}
const pierreDiffWorkerEntry = findPierreDiffsWorker()

// The `@jingler/*` workspace packages ship raw TypeScript source (their
// `exports` point at `src/*.ts`). Node can't run those directly in the main
// process, so we must NOT externalize them — Vite bundles + transpiles them into
// the main/preload output. Third-party deps (effect, @effect/*, electron) stay
// external and load from node_modules as usual.
const workspacePackages = [
  "@jingler/core",
  "@jingler/contracts",
  "@jingler/cli-adapters",
  "@jingler/plannotator-ext",
  "@jingler/themes",
  "@jingler/ui",
  "@jingler/plugin-sdk"
]

export default defineConfig(({ command }) => {
  // Local dev talks to the deployed auth backend unless explicitly overridden.
  if (command === "serve") {
    process.env.JINGLER_AUTH_URL ??= "https://api.jingler.dev"
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
    resolve: {
      // The workspace ships raw @jingler/ui source, while Pierre ships bundled
      // React entry points. Dedupe at the renderer boundary so both resolve to
      // the app's single React/Shiki instances. The @pierre packages must be
      // deduped too — two installed copies split @pierre/diffs' theme-registry
      // singleton and the file view renders blank in dev. The full contract
      // (direct deps at packages/ui's exact versions, one copy for the whole
      // renderer graph) lives in electron.vite.config.test.ts.
      dedupe: ["react", "react-dom", "shiki", "@pierre/diffs", "@pierre/trees"],
      alias: {
        // pierre-provider.tsx uses this static alias in new URL(...). Vite can
        // then emit the worker as a production asset instead of leaving a bare
        // package URL for Electron's file:// runtime to fail on.
        "@jingler/pierre-diffs-worker": pierreDiffWorkerEntry
      }
    },
    worker: { format: "es" },
    optimizeDeps: {
      // Every imported @pierre entrypoint, pre-bundled in one pass — a dep
      // only discovered while serving forces a mid-session re-optimization
      // reload. Kept in sync by electron.vite.config.test.ts.
      include: [
        "@pierre/diffs",
        "@pierre/diffs/edit",
        "@pierre/diffs/react",
        "@pierre/trees",
        "@pierre/trees/react"
      ]
    },
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, "src/renderer/index.html") }
      }
    }
  }
  }
})
