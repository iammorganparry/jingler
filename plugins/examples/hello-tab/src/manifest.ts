import { defineManifest } from "@starbase/plugin-sdk"

/**
 * The manifest, written in TypeScript so its contribution ids are captured as
 * literal types.
 *
 * `scripts/emit-manifest.mjs` writes this out as `starbase.plugin.json` at build
 * time, which is why there is no hand-maintained JSON in this repo: one source
 * of truth, and `definePlugin` in `ui.tsx` is checked against these exact ids.
 *
 * This plugin has no `main`, so it declares no `activationEvents` and Starbase
 * never starts a Node process for it. That is the correct shape for a tab that
 * only renders what the app already knows.
 */
export const manifest = defineManifest({
  id: "hello-tab",
  name: "Hello Tab",
  version: "1.0.0",
  description: "The smallest complete Starbase plugin.",
  ui: "dist/ui.js",
  contributes: {
    tabs: [
      {
        id: "hello-tab.greeting",
        label: "Hello",
        icon: "Sparkles",
        when: "always"
      }
    ]
  }
})
