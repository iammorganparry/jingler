import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * The plugin system, through the real built app.
 *
 * Everything else in this area is a unit test over one link: the protocol serves
 * a file, the loader refuses a bad module, the registry caches by version. This
 * spec is the only place all of them run together with a real Electron main
 * process, a real `starbase-plugin://` handler, a real importmap and a real
 * renderer — which is the only way to know the importmap actually resolves, that
 * the scheme is registered early enough, and that the shims parse as modules.
 *
 * ## Why the plugin is written as raw ES modules rather than built
 *
 * A build step here would test Vite. Writing `dist/ui.js` by hand, importing the
 * exact bare specifiers a real plugin imports, tests what this spec is for: that
 * Starbase resolves them. If the importmap or a shim breaks, this fails; if the
 * bundler changes, it does not.
 *
 * ## Why the plugin is seeded AFTER launch
 *
 * It could be seeded before. Doing it after also proves the watcher: a folder
 * appearing in `~/starbase/plugins` shows up without a restart, which is the
 * whole install story and the thing an author relies on every time they rebuild.
 */

const SESSION: SeedSession = {
  id: "s_plugin_1",
  repo: "widget",
  branch: "starbase/plugin-session",
  title: "Plugin session",
  status: "idle",
  cli: "claude",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-07-11T00:00:00.000Z"
}

const manifest = (over: Record<string, unknown> = {}) => ({
  id: "e2e-tab",
  name: "E2E Tab",
  version: "1.0.0",
  description: "A plugin that exists only for this spec.",
  ui: "dist/ui.js",
  contributes: {
    tabs: [{ id: "e2e-tab.main", label: "E2E", icon: "Boxes", when: "always" }]
  },
  ...over
})

/**
 * A plugin's UI module, hand-written.
 *
 * The three bare specifiers are exactly what a real plugin's bundle contains —
 * `@starbase/plugin-sdk/vite` externalises precisely these — so this exercises
 * the importmap and all three runtime shims.
 */
const UI_MODULE = `
import { jsx, jsxs } from "react/jsx-runtime"
import { definePlugin, useSession, useHost } from "@starbase/plugin-sdk"
import { cn } from "@starbase/plugin-sdk/ui"

function Tab() {
  // Calling the hooks is the point: they resolve through the SDK's React
  // context, which only works if the plugin got the APP's SDK instance.
  const session = useSession()
  const host = useHost()
  return jsxs("div", {
    "data-testid": "e2e-tab-body",
    className: cn("flex flex-1 flex-col gap-2 bg-editor p-6"),
    children: [
      jsx("h2", { className: "text-text", children: "Hello from a plugin" }),
      jsx("div", {
        "data-testid": "e2e-tab-repo",
        className: "text-dim",
        children: session.repo
      }),
      jsx("div", {
        "data-testid": "e2e-tab-bridge",
        className: "text-dim",
        children: typeof host.invoke === "function" ? "bridge ready" : "bridge missing"
      })
    ]
  })
}

export default definePlugin(
  {
    id: "e2e-tab",
    name: "E2E Tab",
    version: "1.0.0",
    ui: "dist/ui.js",
    contributes: {
      tabs: [{ id: "e2e-tab.main", label: "E2E", icon: "Boxes", when: "always" }]
    }
  },
  { views: { "e2e-tab.main": Tab } }
)
`

/** Write a plugin into the launched app's throwaway home. */
const seedPlugin = async (
  home: string,
  opts: { id?: string; ui?: string; manifest?: Record<string, unknown> } = {}
) => {
  const id = opts.id ?? "e2e-tab"
  const dir = join(home, "starbase", "plugins", id)
  await mkdir(join(dir, "dist"), { recursive: true })
  await writeFile(
    join(dir, "starbase.plugin.json"),
    JSON.stringify(opts.manifest ?? manifest(), null, 2),
    "utf8"
  )
  await writeFile(join(dir, "dist", "ui.js"), opts.ui ?? UI_MODULE, "utf8")
  return dir
}

const openSession = async (window: import("@playwright/test").Page) => {
  await window.getByText("Plugin session").click()
}

/** Open Settings and land on the Plugins section. Mirrors the other specs. */
const openPluginSettings = async (window: import("@playwright/test").Page) => {
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await expect(window.getByRole("button", { name: "Close settings" })).toBeVisible()
  await window.getByRole("button", { name: "Plugins" }).click()
}

test("a plugin dropped into ~/starbase/plugins contributes a working tab", async ({
  launchApp
}) => {
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [SESSION]
  })
  await openSession(window)

  // Nothing installed yet.
  await expect(window.getByRole("button", { name: "E2E" })).toHaveCount(0)

  await seedPlugin(home)

  // No restart. The watcher notices, the catalog re-emits, the loader imports
  // the module over `starbase-plugin://`, and the tab appears.
  await expect(window.getByRole("button", { name: "E2E" })).toBeVisible({ timeout: 15_000 })

  await window.getByRole("button", { name: "E2E" }).click()
  await expect(window.getByTestId("e2e-tab-body")).toBeVisible()

  // `useSession` resolved — so the plugin got the app's SDK instance, its React
  // context, and a narrowed session snapshot.
  await expect(window.getByTestId("e2e-tab-repo")).toHaveText("widget")
  // `useHost` resolved too, which is the bridge to its host half.
  await expect(window.getByTestId("e2e-tab-bridge")).toHaveText("bridge ready")
})

test("Settings lists the plugin, and disabling it removes the tab", async ({ launchApp }) => {
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [SESSION]
  })
  await seedPlugin(home)
  await openSession(window)
  await expect(window.getByRole("button", { name: "E2E" })).toBeVisible({ timeout: 15_000 })

  await openPluginSettings(window)

  await expect(window.getByTestId("plugin-row-e2e-tab")).toBeVisible()
  await window.getByLabel("Enable E2E Tab").click()

  await window.getByRole("button", { name: "Close settings" }).click()
  // A disabled plugin runs no code and contributes nothing — otherwise the
  // switch would be advisory.
  await expect(window.getByRole("button", { name: "E2E" })).toHaveCount(0, { timeout: 15_000 })
})

test("a plugin whose manifest will not decode is reported, not silently absent", async ({
  launchApp
}) => {
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [SESSION]
  })

  // A missing plugin and a broken one look identical from the session pane, so
  // Settings has to be able to tell them apart.
  const dir = join(home, "starbase", "plugins", "broken")
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, "starbase.plugin.json"),
    JSON.stringify({ id: "broken", name: "Broken", activationEvents: ["onStartup"] }),
    "utf8"
  )

  await openPluginSettings(window)

  const undecodable = window.getByTestId("plugins-undecodable")
  await expect(undecodable).toBeVisible({ timeout: 15_000 })
  await expect(undecodable).toContainText("broken")
})

test("a plugin whose module throws shows a failure card, and other tabs keep working", async ({
  launchApp
}) => {
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [SESSION]
  })

  await seedPlugin(home, {
    ui: `
import { definePlugin } from "@starbase/plugin-sdk"
function Tab() { throw new Error("plugin exploded") }
export default definePlugin(
  {
    id: "e2e-tab", name: "E2E Tab", version: "1.0.0", ui: "dist/ui.js",
    contributes: { tabs: [{ id: "e2e-tab.main", label: "E2E", when: "always" }] }
  },
  { views: { "e2e-tab.main": Tab } }
)
`
  })

  await openSession(window)
  await expect(window.getByRole("button", { name: "E2E" })).toBeVisible({ timeout: 15_000 })
  await window.getByRole("button", { name: "E2E" }).click()

  // The error boundary names the plugin rather than blanking the window.
  await expect(window.getByTestId("plugin-error-e2e-tab")).toBeVisible()
  await expect(window.getByText(/plugin exploded/)).toBeVisible()

  // The app is intact: Conversation still works.
  await window.getByRole("button", { name: "Conversation" }).click()
  await expect(window.getByTestId("plugin-error-e2e-tab")).toHaveCount(0)
})

test("a plugin with a host half activates and answers an invoke", async ({ launchApp }) => {
  // The gap that let the extension host fork a filename the build never emits:
  // the unit tests drive a fake `HostProcess` and every other e2e plugin is
  // UI-only, so the REAL spawn path had zero coverage. This is the only test
  // that starts an actual utilityProcess.
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [SESSION]
  })

  await seedPlugin(home, {
    manifest: manifest({
      main: "dist/main.js",
      activationEvents: ["onTab:e2e-tab.main"],
      contributes: {
        tabs: [{ id: "e2e-tab.main", label: "E2E", icon: "Boxes", when: "always" }],
        commands: [{ id: "e2e-tab.ping", title: "Ping" }]
      }
    }),
    ui: `
import { jsx, jsxs } from "react/jsx-runtime"
import { definePlugin, useHost } from "@starbase/plugin-sdk"
import { useEffect, useState } from "react"

function Tab() {
  const host = useHost()
  const [answer, setAnswer] = useState("…")
  useEffect(() => {
    host.invoke("e2e-tab.ping", { n: 41 })
      .then((r) => setAnswer(String(r)))
      .catch((e) => setAnswer("error: " + String(e && e.message ? e.message : e)))
  }, [host])
  return jsxs("div", {
    "data-testid": "e2e-tab-body",
    children: [
      jsx("span", { children: "host half" }),
      jsx("div", { "data-testid": "e2e-host-answer", children: answer })
    ]
  })
}

export default definePlugin(
  {
    id: "e2e-tab", name: "E2E Tab", version: "1.0.0", ui: "dist/ui.js", main: "dist/main.js",
    contributes: {
      tabs: [{ id: "e2e-tab.main", label: "E2E", when: "always" }],
      commands: [{ id: "e2e-tab.ping", title: "Ping" }]
    }
  },
  { views: { "e2e-tab.main": Tab } }
)
`
  })

  // The host half. Plain Node — no imports, so no bundling required.
  await writeFile(
    join(home, "starbase", "plugins", "e2e-tab", "dist", "main.js"),
    `export const activate = (ctx) => {
  ctx.subscriptions.push(
    ctx.commands.register("e2e-tab.ping", async (arg) => (arg?.n ?? 0) + 1)
  )
}
`,
    "utf8"
  )

  await openSession(window)
  await expect(window.getByRole("button", { name: "E2E" })).toBeVisible({ timeout: 15_000 })
  await window.getByRole("button", { name: "E2E" }).click()

  // 42 means: the process spawned, reported ready, imported main.js, ran
  // activate(), registered the command, and round-tripped an invoke.
  await expect(window.getByTestId("e2e-host-answer")).toHaveText("42", { timeout: 20_000 })
})

test("a plugin is served from the throwaway home, not the developer's own", async ({
  launchApp
}) => {
  // Not a tautology about `join(home, …)` — that only asserted the test's own
  // arithmetic. This proves the RUNNING APP resolved `STARBASE_HOME`: the plugin
  // exists only under the temp home, so a tab appearing at all means the
  // protocol handler read from there rather than the developer's ~/starbase.
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [SESSION]
  })
  await seedPlugin(home, { id: "scoped-to-home" , manifest: manifest({ id: "scoped-to-home",
    contributes: { tabs: [{ id: "scoped-to-home.main", label: "Scoped", when: "always" }] } }),
    ui: UI_MODULE.replace(/e2e-tab/g, "scoped-to-home").replace(/"E2E"/g, '"Scoped"') })

  await openSession(window)
  await expect(window.getByRole("button", { name: "Scoped" })).toBeVisible({ timeout: 15_000 })

  // And it goes away with the home, rather than lingering in a real one.
  await rm(join(home, "starbase", "plugins", "scoped-to-home"), {
    recursive: true,
    force: true
  })
  await expect(window.getByRole("button", { name: "Scoped" })).toHaveCount(0, { timeout: 15_000 })
})
