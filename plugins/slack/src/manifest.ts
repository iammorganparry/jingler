import { defineManifest } from "@jingler/plugin-sdk"

/**
 * Written in TypeScript so the contribution ids below are captured as literal
 * types: `definePlugin` in `ui.tsx` then requires a matching view for each one,
 * and a typo is a compile error rather than a tab that opens onto nothing.
 *
 * `pnpm build` generates `jingler.plugin.json` from this. Do not hand-edit the
 * JSON — it is overwritten.
 */
export const manifest = defineManifest({
  id: "slack",
  name: "Slack",
  version: "1.0.0",
  description: "A Jingler plugin.",
  // The plugin API generation this targets. A Jingler too old to speak it
  // refuses the plugin with a sentence naming both versions, instead of
  // evaluating your bundle against an SDK missing what it expects and handing
  // the operator a stack trace. Bump only if the SDK's own major does.
  apiVersion: 1,
  ui: "dist/ui.js",
  // No `main`, so no host half and no Node process. Add one when you need the
  // network, a CLI or credentials — the renderer cannot reach any of those.
  contributes: {
    tabs: [
      {
        id: "slack.main",
        label: "Slack",
        // Any lucide icon name. An unknown one falls back to a box.
        icon: "Boxes",
        when: "always"
      }
    ]
  }
})
