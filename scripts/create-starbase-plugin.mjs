#!/usr/bin/env node
/**
 * Scaffold a Starbase plugin.
 *
 *   node scripts/create-starbase-plugin.mjs my-plugin
 *
 * ## Why the output is a WORKING plugin, not a skeleton
 *
 * A scaffold that needs edits before it builds teaches the wrong first lesson:
 * the author's first experience becomes debugging someone else's template
 * rather than seeing their own tab appear. What this writes builds and installs
 * with no changes, and `plugins/examples/hello-tab` — which is the same output,
 * checked in — is compiled by CI so it cannot rot into a template that no longer
 * works.
 *
 * ## Why it emits TypeScript manifests rather than JSON
 *
 * Starbase reads `starbase.plugin.json`, but the scaffold writes
 * `src/manifest.ts` and generates the JSON at build time. That is what lets
 * `definePlugin` check the views against the declared tab ids — rename a tab and
 * get a compile error, rather than a tab that opens onto nothing.
 */
import { mkdir, writeFile, access } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)))

const id = process.argv[2]

if (!id) {
  console.error("Usage: node scripts/create-starbase-plugin.mjs <plugin-id>")
  console.error("  <plugin-id> is lowercase kebab-case, e.g. my-plugin")
  process.exit(1)
}

// The same constraint `PluginId` enforces in `@starbase/core`. Checked here so
// the failure arrives before any files exist, rather than at first load.
if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
  console.error(`"${id}" is not a valid plugin id.`)
  console.error("Use lowercase letters, digits and hyphens, e.g. my-plugin.")
  process.exit(1)
}

const dir = join(REPO, "plugins", id)

try {
  await access(dir)
  console.error(`plugins/${id} already exists. Pick another id or remove it.`)
  process.exit(1)
} catch {
  // Does not exist, which is what we want.
}

/** Turn `my-plugin` into `My Plugin`, and `MyPluginTab`. */
const title = id
  .split("-")
  .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
  .join(" ")
const component = `${title.replace(/ /g, "")}Tab`

const files = {
  "package.json": `${JSON.stringify(
    {
      name: `@starbase-plugin/${id}`,
      version: "1.0.0",
      private: true,
      type: "module",
      description: `A Starbase plugin.`,
      scripts: {
        build: "vite build && tsx ./scripts/emit-manifest.mjs",
        typecheck: "tsc --noEmit",
        "install:local": "node ./scripts/install-local.mjs"
      },
      devDependencies: {
        "@starbase/plugin-sdk": "workspace:*",
        "@starbase/tsconfig": "workspace:*",
        "@types/react": "^19.2.0",
        "@vitejs/plugin-react": "^5.2.0",
        react: "^19.2.0",
        tsx: "^4.23.1",
        typescript: "^5.9.3",
        vite: "^7.3.6"
      }
    },
    null,
    2
  )}\n`,

  "tsconfig.json": `{
  "extends": "@starbase/tsconfig/react.json",
  "include": ["src", "vite.config.ts"]
}
`,

  ".gitignore": "dist/\nnode_modules/\n",

  "vite.config.ts": `import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { starbasePluginBuild } from "@starbase/plugin-sdk/vite"

/**
 * \`starbasePluginBuild\` sets the externals that matter: react, react-dom, the
 * JSX runtimes and the SDK all come from Starbase at runtime. Bundling any of
 * them — React especially — puts two copies in one tree and makes every hook
 * throw, but only once a SECOND plugin is installed.
 *
 * Add \`main: "src/main.ts"\` here when you add a host half, or the file your
 * manifest names will never be written.
 */
export default defineConfig({
  plugins: [react()],
  build: starbasePluginBuild({ ui: "src/ui.tsx" })
})
`,

  "src/manifest.ts": `import { defineManifest } from "@starbase/plugin-sdk"

/**
 * Written in TypeScript so the contribution ids below are captured as literal
 * types: \`definePlugin\` in \`ui.tsx\` then requires a matching view for each one,
 * and a typo is a compile error rather than a tab that opens onto nothing.
 *
 * \`pnpm build\` generates \`starbase.plugin.json\` from this. Do not hand-edit the
 * JSON — it is overwritten.
 */
export const manifest = defineManifest({
  id: "${id}",
  name: "${title}",
  version: "1.0.0",
  description: "A Starbase plugin.",
  // The plugin API generation this targets. A Starbase too old to speak it
  // refuses the plugin with a sentence naming both versions, instead of
  // evaluating your bundle against an SDK missing what it expects and handing
  // the operator a stack trace. Bump only if the SDK's own major does.
  apiVersion: 1,
  ui: "dist/ui.js",
  // No \`main\`, so no host half and no Node process. Add one when you need the
  // network, a CLI or credentials — the renderer cannot reach any of those.
  contributes: {
    tabs: [
      {
        id: "${id}.main",
        label: "${title}",
        // Any lucide icon name. An unknown one falls back to a box.
        icon: "Boxes",
        when: "always"
      }
    ]
  }
})
`,

  "src/ui.tsx": `import { definePlugin, useSession, type TabProps } from "@starbase/plugin-sdk"
// The themed kit is a separate entrypoint so Node-side build scripts can import
// the root without pulling the component library in.
import { cn } from "@starbase/plugin-sdk/ui"
import { manifest } from "./manifest.js"

/**
 * Every colour here is a \`--sb-*\` theme token — \`bg-editor\`, \`text-text\`,
 * \`border-line\` — never a hex. A literal colour survives a theme switch
 * unchanged, which on a light theme means white text on white.
 */
function ${component}({ session }: TabProps) {
  // \`session\` is also available anywhere below via \`useSession()\`.
  void useSession

  return (
    <div className={cn("flex flex-1 flex-col gap-3 overflow-auto bg-editor p-6")}>
      <h2 className="text-[15px] font-semibold text-text">${title}</h2>
      <p className="text-[12.5px] leading-[1.6] text-dim">
        Editing <code className="text-blue">src/ui.tsx</code>? Bump{" "}
        <code className="text-blue">version</code> in{" "}
        <code className="text-blue">src/manifest.ts</code> and rebuild — module
        imports are cached by URL, so the old one loads otherwise.
      </p>
      <dl className="flex flex-col gap-px overflow-hidden rounded border border-line">
        {[
          ["Repo", session.repo],
          ["Branch", session.branch],
          ["Agent", session.cli]
        ].map(([label, value]) => (
          <div key={label} className="flex items-baseline gap-3 bg-panel px-3 py-2">
            <dt className="w-24 flex-none text-[11.5px] uppercase tracking-wide text-dim">
              {label}
            </dt>
            <dd className="truncate font-mono text-[12.5px] text-text-body">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export default definePlugin(manifest, {
  // Every tab the manifest declares must appear here, and nothing else may.
  views: { "${id}.main": ${component} }
})
`,

  "scripts/emit-manifest.mjs": `/**
 * Write \`starbase.plugin.json\` from the TypeScript manifest.
 *
 * One source of truth: a hand-maintained JSON copy drifts the first time
 * someone renames a tab.
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { manifest } from "../src/manifest.ts"

const out = fileURLToPath(new URL("../starbase.plugin.json", import.meta.url))
writeFileSync(out, \`\${JSON.stringify(manifest, null, 2)}\\n\`, "utf8")
console.log(\`Wrote \${out}\`)
`,

  "scripts/install-local.mjs": `/**
 * Copy this plugin into \`~/starbase/plugins/${id}\` so the running app picks it
 * up. Honours \`STARBASE_HOME\`.
 *
 * Copies rather than symlinks: the protocol handler resolves every request
 * through \`realpath\` and refuses anything landing outside the plugins root, so
 * a symlinked plugin directory would be served exactly zero files. That guard
 * is working as intended — this script just respects it.
 */
import { cp, mkdir, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const src = fileURLToPath(new URL("..", import.meta.url))
const root = join(process.env.STARBASE_HOME ?? homedir(), "starbase", "plugins")
const dest = join(root, "${id}")

await mkdir(root, { recursive: true })
await rm(dest, { recursive: true, force: true })
await mkdir(dest, { recursive: true })

for (const entry of ["starbase.plugin.json", "dist"]) {
  await cp(join(src, entry), join(dest, entry), { recursive: true })
}

console.log(\`Installed ${id} to \${dest}\`)
console.log("The app picks it up live — no restart needed.")
`,

  "AGENTS.md": `# ${title} — a Starbase plugin

The complete authoring contract is in
\`packages/plugin-sdk/AGENTS.md\`, and every export is listed in
\`packages/plugin-sdk/api-digest.md\`. Read the first one before changing
anything here.

## This plugin

- \`src/manifest.ts\` — what it contributes. Bump \`version\` to see edits.
- \`src/ui.tsx\` — the tab. Only \`--sb-*\` theme tokens, never hex colours.
- No host half yet. Add \`src/main.ts\` plus \`main: "dist/main.js"\` in the
  manifest AND \`main: "src/main.ts"\` in \`vite.config.ts\` when you need the
  network, a CLI or credentials — the renderer can reach none of those.

## Commands

\`\`\`bash
pnpm build          # bundle + regenerate starbase.plugin.json
pnpm install:local  # copy into ~/starbase/plugins
pnpm typecheck
\`\`\`
`,

  "README.md": `# ${title}

A Starbase plugin.

\`\`\`bash
pnpm install
pnpm build
pnpm install:local
\`\`\`

The tab appears in every session immediately — Starbase watches
\`~/starbase/plugins\` and reloads without a restart.

Editing and seeing nothing? Bump \`version\` in \`src/manifest.ts\`. Module imports
are cached by URL for the life of the window.

See \`packages/plugin-sdk/AGENTS.md\` for the full contract.
`
}

for (const [path, contents] of Object.entries(files)) {
  const target = join(dir, path)
  await mkdir(join(target, ".."), { recursive: true })
  await writeFile(target, contents, "utf8")
}

console.log(`Created plugins/${id}`)
console.log("")
console.log("  pnpm install")
console.log(`  pnpm --filter @starbase-plugin/${id} build`)
console.log(`  pnpm --filter @starbase-plugin/${id} install:local`)
console.log("")
console.log("Then open any session — the tab is there.")
