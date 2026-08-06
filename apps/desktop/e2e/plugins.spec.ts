import { existsSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { appShell, expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * The plugin system, through the real built app.
 *
 * Everything else in this area is a unit test over one link: the protocol serves
 * a file, the loader refuses a bad module, the registry caches by version. This
 * spec is the only place all of them run together with a real Electron main
 * process, a real `jingler-plugin://` handler, a real importmap and a real
 * renderer — which is the only way to know the importmap actually resolves, that
 * the scheme is registered early enough, and that the shims parse as modules.
 *
 * ## Why the plugin is written as raw ES modules rather than built
 *
 * A build step here would test Vite. Writing `dist/ui.js` by hand, importing the
 * exact bare specifiers a real plugin imports, tests what this spec is for: that
 * Jingler resolves them. If the importmap or a shim breaks, this fails; if the
 * bundler changes, it does not.
 *
 * ## Why the plugin is seeded AFTER launch
 *
 * It could be seeded before. Doing it after also proves the watcher: a folder
 * appearing in `~/jingler/plugins` shows up without a restart, which is the
 * whole install story and the thing an author relies on every time they rebuild.
 */

const SESSION: SeedSession = {
  id: "s_plugin_1",
  repo: "widget",
  branch: "chore/plugin-session",
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
 * `@jingler/plugin-sdk/vite` externalises precisely these — so this exercises
 * the importmap and all three runtime shims.
 */
const UI_MODULE = `
import { jsx, jsxs } from "react/jsx-runtime"
import { definePlugin, useSession, useHost } from "@jingler/plugin-sdk"
import { cn } from "@jingler/plugin-sdk/ui"

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
  const dir = join(home, "jingler", "plugins", id)
  await mkdir(join(dir, "dist"), { recursive: true })
  await writeFile(
    join(dir, "jingler.plugin.json"),
    JSON.stringify(opts.manifest ?? manifest(), null, 2),
    "utf8"
  )
  await writeFile(join(dir, "dist", "ui.js"), opts.ui ?? UI_MODULE, "utf8")
  return dir
}

/**
 * A second plugin, written independently of the first.
 *
 * Its whole job is to be a SECOND one. The runtime shims, the importmap and the
 * `react-dom` singleton all exist because two plugins that each bundled React
 * would give the tree two copies and make every hook throw — and the failure is
 * invisible until the second plugin arrives, which is to say after the author
 * shipped. Both tabs calling `useState` is the assertion.
 */
const SECOND_UI = `
import { jsx, jsxs } from "react/jsx-runtime"
import { definePlugin, useSession } from "@jingler/plugin-sdk"
import { useState } from "react"

function Tab() {
  // A hook with STATE, not just context: a duplicate React fails here loudly
  // ("Invalid hook call") rather than returning a plausible undefined.
  const [n] = useState(7)
  const session = useSession()
  return jsxs("div", {
    "data-testid": "second-tab-body",
    children: [
      jsx("span", { "data-testid": "second-tab-state", children: String(n) }),
      jsx("span", { "data-testid": "second-tab-repo", children: session.repo })
    ]
  })
}

export default definePlugin(
  {
    id: "second-plugin", name: "Second Plugin", version: "1.0.0", ui: "dist/ui.js",
    contributes: { tabs: [{ id: "second-plugin.main", label: "Second", when: "always" }] }
  },
  { views: { "second-plugin.main": Tab } }
)
`

const secondManifest = {
  id: "second-plugin",
  name: "Second Plugin",
  version: "1.0.0",
  ui: "dist/ui.js",
  contributes: {
    tabs: [{ id: "second-plugin.main", label: "Second", when: "always" }]
  }
}

/**
 * Click the seeded session in the SIDEBAR.
 *
 * By test id, not by text. The tab-chrome redesign put the session's title on the
 * conversation chip, so "Plugin session" now appears twice on screen — once in the
 * sidebar row and once in the pane's own header — and a bare `getByText` is a
 * strict-mode violation rather than a click.
 */
const openSession = async (window: import("@playwright/test").Page) => {
  await window.getByTestId(`session-row-${SESSION.id}`).click()
}

/** Open Settings and land on the Plugins section. Mirrors the other specs. */
const openPluginSettings = async (window: import("@playwright/test").Page) => {
  await expect(appShell(window)).toBeVisible()
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await expect(window.getByRole("button", { name: "Close settings" })).toBeVisible()
  await window.getByRole("button", { name: "Plugins" }).click()
}

test("a plugin dropped into ~/jingler/plugins contributes a working tab", async ({
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
  // the module over `jingler-plugin://`, and the tab appears.
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
  const dir = join(home, "jingler", "plugins", "broken")
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, "jingler.plugin.json"),
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
import { definePlugin } from "@jingler/plugin-sdk"
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

  // The app is intact: the active chat still returns to the conversation.
  await window.getByTestId("active-chat-tab").click()
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
import { definePlugin, useHost } from "@jingler/plugin-sdk"
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
    join(home, "jingler", "plugins", "e2e-tab", "dist", "main.js"),
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
  // arithmetic. This proves the RUNNING APP resolved `JINGLER_HOME`: the plugin
  // exists only under the temp home, so a tab appearing at all means the
  // protocol handler read from there rather than the developer's ~/jingler.
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
  await rm(join(home, "jingler", "plugins", "scoped-to-home"), {
    recursive: true,
    force: true
  })
  await expect(window.getByRole("button", { name: "Scoped" })).toHaveCount(0, { timeout: 15_000 })
})

test("a plugin built in dev mode renders — jsxDEV resolves", async ({ launchApp }) => {
  // Vite in DEVELOPMENT mode emits `jsxDEV(...)` and imports
  // `react/jsx-dev-runtime`. The shim for that specifier listed `jsxDEV` among its
  // exports (the name came from the union of both React namespaces) while taking
  // its values from the production namespace, which has no `jsxDEV` — so the name
  // resolved to `undefined` and the plugin died on its first element with
  // `jsxDEV is not a function`.
  //
  // It broke the official `github-issues` tab and every dev-built third-party
  // plugin, and no test saw it: every hand-written plugin in this spec imports
  // `react/jsx-runtime` directly, which is what a PRODUCTION build emits. This is
  // the only case that takes the dev path.
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [SESSION]
  })

  await seedPlugin(home, {
    ui: `
import { jsxDEV } from "react/jsx-dev-runtime"
import { definePlugin, useSession } from "@jingler/plugin-sdk"

function Tab() {
  const session = useSession()
  // The extra (source, self) arguments are exactly what a dev build passes.
  return jsxDEV("div", {
    "data-testid": "dev-built-body",
    children: jsxDEV("span", { children: session.repo }, undefined, false, undefined, this)
  }, undefined, false, undefined, this)
}

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

  const body = window.getByTestId("dev-built-body")
  await expect(body).toBeVisible()
  // Scoped to the plugin's own body: "widget" is the repo name, which the sidebar
  // also shows, so an unscoped `getByText` is a strict-mode violation.
  await expect(body.getByText("widget")).toBeVisible()
  // Not the error card, which is what this produced before.
  await expect(window.getByTestId("plugin-error-e2e-tab")).toHaveCount(0)
})

test("two plugins share one React — both render, neither throws", async ({ launchApp }) => {
  // The single most valuable test in this file, because it is the one failure the
  // whole runtime-shim/importmap apparatus exists to prevent and the one an
  // author cannot hit while developing: with one plugin installed, a bundled
  // React works fine. Every other test here installs exactly one plugin, so a
  // regression in the shims passed the entire suite and broke in the field the
  // first time a user installed a second plugin.
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [SESSION]
  })

  await seedPlugin(home)
  await seedPlugin(home, {
    id: "second-plugin",
    manifest: secondManifest,
    ui: SECOND_UI
  })

  await openSession(window)

  await expect(window.getByRole("button", { name: "E2E" })).toBeVisible({ timeout: 15_000 })
  await expect(window.getByRole("button", { name: "Second" })).toBeVisible({ timeout: 15_000 })

  // The first plugin's hooks still resolve with a second one loaded.
  await window.getByRole("button", { name: "E2E" }).click()
  await expect(window.getByTestId("e2e-tab-repo")).toHaveText("widget")

  // And the second's `useState` returns its value rather than throwing
  // "Invalid hook call" — which is what a duplicate React produces.
  await window.getByRole("button", { name: "Second" }).click()
  await expect(window.getByTestId("second-tab-state")).toHaveText("7")
  await expect(window.getByTestId("second-tab-repo")).toHaveText("widget")

  // No error boundary fired for either.
  await expect(window.getByTestId("plugin-error-e2e-tab")).toHaveCount(0)
  await expect(window.getByTestId("plugin-error-second-plugin")).toHaveCount(0)
})

test("a disabled plugin stays disabled after a restart", async ({ launchApp }) => {
  // Disabling is usually an act of damage control — the plugin is misbehaving and
  // the operator wants it to stop. If the switch does not survive a relaunch, the
  // plugin comes back on next launch and the control was theatre. The existing
  // disable test only asserts within one session, so this is the half that
  // matters.
  const first = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [SESSION]
  })
  await seedPlugin(first.home)

  await openSession(first.window)
  await expect(first.window.getByRole("button", { name: "E2E" })).toBeVisible({ timeout: 15_000 })

  await openPluginSettings(first.window)
  await first.window.getByLabel("Enable E2E Tab").click()
  await first.window.getByRole("button", { name: "Close settings" }).click()
  await expect(first.window.getByRole("button", { name: "E2E" })).toHaveCount(0, {
    timeout: 15_000
  })
  await first.app.close()

  // Same ~/jingler, nothing re-seeded: the plugin folder is still on disk, so a
  // tab appearing would mean `disabledPlugins` did not persist.
  const second = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    configured: true,
    withRepo: true
  })

  await openSession(second.window)
  // Wait for a tab that IS expected before asserting on absence, or this passes
  // simply by racing the plugin load.
  await expect(second.window.getByTestId("active-chat-tab")).toBeVisible({
    timeout: 15_000
  })
  await expect(second.window.getByRole("button", { name: "E2E" })).toHaveCount(0)

  // And Settings agrees it is off, rather than the tab merely failing to load.
  await openPluginSettings(second.window)
  await expect(second.window.getByTestId("plugin-row-e2e-tab")).toBeVisible()
  await expect(second.window.getByLabel("Enable E2E Tab")).not.toBeChecked()
})

test("Uninstall removes the plugin from disk and the tab from the session", async ({
  launchApp
}) => {
  // The existing coverage deletes the folder with `fs.rm` from the test, which
  // proves the watcher notices a removal and nothing about the UI that performs
  // one. This drives the real path: the confirm step, the id→directory
  // resolution, and the `remove` itself.
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [SESSION]
  })
  const dir = await seedPlugin(home)

  await openSession(window)
  await expect(window.getByRole("button", { name: "E2E" })).toBeVisible({ timeout: 15_000 })

  await openPluginSettings(window)
  await window.getByTestId("plugin-uninstall-e2e-tab").click()
  // Two-step on purpose — deleting a folder is not undoable, so the first click
  // must not do it.
  await expect(window.getByText("Remove this plugin’s folder?")).toBeVisible()
  await window.getByTestId("plugin-uninstall-confirm-e2e-tab").click()

  await expect(window.getByTestId("plugin-row-e2e-tab")).toHaveCount(0, { timeout: 15_000 })

  // Gone from disk, not just from the list.
  expect(existsSync(dir)).toBe(false)

  await window.getByRole("button", { name: "Close settings" }).click()
  await expect(window.getByRole("button", { name: "E2E" })).toHaveCount(0, { timeout: 15_000 })
})

test("Install from folder copies a plugin in and it starts contributing", async ({
  launchApp
}) => {
  // This button rendered for nobody until `use-plugins.ts` was given an
  // `onInstallFromFolder`, and the service behind it refused every install
  // because it resolved the destination with `dirFor`, which only returns
  // directories that already exist. Both were invisible to a suite that installed
  // plugins by writing files directly into the plugins folder.
  const { window, app, home } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [SESSION]
  })

  // A plugin sitting OUTSIDE ~/jingler/plugins, the way a downloaded one would.
  const source = join(home, "downloads", "e2e-tab")
  await mkdir(join(source, "dist"), { recursive: true })
  await writeFile(
    join(source, "jingler.plugin.json"),
    JSON.stringify(manifest(), null, 2),
    "utf8"
  )
  await writeFile(join(source, "dist", "ui.js"), UI_MODULE, "utf8")

  // The picker is a native modal, so it is stubbed the way `auth.spec.ts` stubs
  // `shell.openExternal`: the test cannot click an OS dialog, but everything
  // downstream of the chosen path is the real thing.
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = () =>
      Promise.resolve({ canceled: false, filePaths: [chosen] }) as never
  }, source)

  await openPluginSettings(window)
  // Not "the list is empty": in development `builtinPluginsRoot()` is the repo's
  // own `plugins/`, so the official GitHub Issues plugin is always listed. The
  // assertion is about THIS plugin's absence, before and then presence, after.
  await expect(window.getByTestId("plugin-row-e2e-tab")).toHaveCount(0)
  await window.getByTestId("plugin-install-folder").click()

  await expect(window.getByTestId("plugin-row-e2e-tab")).toBeVisible({ timeout: 15_000 })
  // Copied into the managed directory rather than referenced where it sat.
  expect(existsSync(join(home, "jingler", "plugins", "e2e-tab", "dist", "ui.js"))).toBe(true)

  await window.getByRole("button", { name: "Close settings" }).click()
  await openSession(window)
  await expect(window.getByRole("button", { name: "E2E" })).toBeVisible({ timeout: 15_000 })
})

test("cancelling the install picker changes nothing", async ({ launchApp }) => {
  // Cancelling a dialog is the most common thing that happens to a dialog, and
  // the contract models it as a `null` success precisely so it does not surface
  // as a failure. If that regressed to an error the operator would get a red
  // toast for closing a window.
  const { window, app } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [SESSION]
  })

  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: true, filePaths: [] }) as never
  })

  await openPluginSettings(window)
  // The built-in GitHub Issues plugin is the whole list before the click (see
  // the note in the install test about the development bundled root).
  await expect(window.getByTestId("plugin-row-github-issues")).toBeVisible({ timeout: 15_000 })
  await window.getByTestId("plugin-install-folder").click()

  // Nothing installed, and no failure reported for closing a dialog.
  await expect(window.getByTestId("plugin-row-github-issues")).toBeVisible()
  await expect(window.getByTestId("plugins-undecodable")).toHaveCount(0)
})

test("a plugin's dock pane mounts beside the session", async ({ launchApp }) => {
  // Panes are a whole contribution type with no coverage — every other test
  // plugin is tab-only. They mount differently (once per window, not once per
  // session pane) and through a different branch of the loader, so "tabs work"
  // says nothing about them.
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [SESSION]
  })

  await seedPlugin(home, {
    id: "pane-plugin",
    manifest: {
      id: "pane-plugin",
      name: "Pane Plugin",
      version: "1.0.0",
      ui: "dist/ui.js",
      contributes: {
        panes: [{ id: "pane-plugin.side", label: "Side", slot: "right", defaultSize: 220 }]
      }
    },
    ui: `
import { jsx } from "react/jsx-runtime"
import { definePlugin } from "@jingler/plugin-sdk"

// A pane is handed \`session\`, which may be null — rendering the repo proves the
// pane got the FOCUSED session rather than an empty prop.
function Side({ session }) {
  return jsx("div", {
    "data-testid": "pane-plugin-body",
    children: session ? "docked:" + session.repo : "docked:none"
  })
}

// \`panes\`, not \`views\`. They are separate keys because a pane's props differ
// from a tab's, and mixing them would mean one map whose value type depends on
// which contribution the key happens to name.
export default definePlugin(
  {
    id: "pane-plugin", name: "Pane Plugin", version: "1.0.0", ui: "dist/ui.js",
    contributes: {
      panes: [{ id: "pane-plugin.side", label: "Side", slot: "right", defaultSize: 220 }]
    }
  },
  { panes: { "pane-plugin.side": Side } }
)
`
  })

  await openSession(window)

  await expect(window.getByTestId("plugin-dock-pane-plugin.side")).toBeVisible({
    timeout: 15_000
  })
  await expect(window.getByTestId("pane-plugin-body")).toHaveText("docked:widget")

  // A pane is a window-level dock, so it must not have been filed as a tab.
  // `exact` matters: the default is a case-insensitive substring match, and
  // "Side" is inside "Collapse sidebar".
  await expect(window.getByRole("button", { name: "Side", exact: true })).toHaveCount(0)
})

test("storage written by the host half is read by the UI half, and survives a restart", async ({
  launchApp
}) => {
  // The design's promise is that the two halves share one store. Nothing tested
  // that they agree, and they are two separate implementations either side of an
  // RPC — the UI half goes through `plugin-bridge`, the host half through
  // `plugin-host-bridge`. A divergence here is silent data loss for every plugin
  // that persists anything.
  const STORAGE_UI = `
import { jsx, jsxs } from "react/jsx-runtime"
import { definePlugin, useHost, usePluginStorage } from "@jingler/plugin-sdk"
import { useEffect, useState } from "react"

function Tab() {
  const host = useHost()
  const storage = usePluginStorage()
  const [seen, setSeen] = useState("…")
  useEffect(() => {
    // Waking the host half is what writes the key on a first run; on a relaunch
    // the value is already on disk and this just re-confirms it.
    host.invoke("store-plugin.touch", {})
      .then(() => storage.get("greeting"))
      .then((v) => setSeen(v === undefined ? "unset" : String(v)))
      .catch((e) => setSeen("error: " + String(e && e.message ? e.message : e)))
  }, [host, storage])
  return jsxs("div", {
    children: [jsx("span", { "data-testid": "store-seen", children: seen })]
  })
}

export default definePlugin(
  {
    id: "store-plugin", name: "Store Plugin", version: "1.0.0",
    ui: "dist/ui.js", main: "dist/main.js",
    contributes: {
      tabs: [{ id: "store-plugin.main", label: "Store", when: "always" }],
      commands: [{ id: "store-plugin.touch", title: "Touch" }]
    }
  },
  { views: { "store-plugin.main": Tab } }
)
`
  const storageManifest = {
    id: "store-plugin",
    name: "Store Plugin",
    version: "1.0.0",
    ui: "dist/ui.js",
    main: "dist/main.js",
    activationEvents: ["onTab:store-plugin.main"],
    contributes: {
      tabs: [{ id: "store-plugin.main", label: "Store", when: "always" }],
      commands: [{ id: "store-plugin.touch", title: "Touch" }]
    }
  }
  // Writes only if unset, so the relaunch reads what the FIRST run stored rather
  // than a value this run just rewrote.
  const STORAGE_MAIN = `export const activate = (ctx) => {
  ctx.subscriptions.push(
    ctx.commands.register("store-plugin.touch", async () => {
      const existing = await ctx.storage.get("greeting")
      if (existing === undefined) await ctx.storage.set("greeting", "from-the-host")
      return true
    })
  )
}
`

  const first = await launchApp({ configured: true, withRepo: true, sessions: [SESSION] })
  await seedPlugin(first.home, {
    id: "store-plugin",
    manifest: storageManifest,
    ui: STORAGE_UI
  })
  await writeFile(
    join(first.home, "jingler", "plugins", "store-plugin", "dist", "main.js"),
    STORAGE_MAIN,
    "utf8"
  )

  await openSession(first.window)
  await expect(first.window.getByRole("button", { name: "Store" })).toBeVisible({
    timeout: 15_000
  })
  await first.window.getByRole("button", { name: "Store" }).click()

  // The UI half reading a value only the HOST half ever wrote.
  await expect(first.window.getByTestId("store-seen")).toHaveText("from-the-host", {
    timeout: 20_000
  })
  await first.app.close()

  const second = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    configured: true,
    withRepo: true
  })
  await openSession(second.window)
  await second.window.getByRole("button", { name: "Store" }).click()
  await expect(second.window.getByTestId("store-seen")).toHaveText("from-the-host", {
    timeout: 20_000
  })
})

test("bumping the version re-imports the module, so an edit is visible", async ({
  launchApp
}) => {
  // The author's inner loop, and the one the docs warn about hardest: ES module
  // imports are cached by URL for the life of the window, so the loader keys the
  // module by manifest version. Coverage existed for ADDING a plugin and for
  // REMOVING one; editing — the thing an author does fifty times an hour — had
  // none, and if the version key regressed, every author's edits would silently
  // do nothing.
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [SESSION]
  })

  const withLabel = (version: string, body: string) => ({
    manifest: manifest({ version }),
    ui: UI_MODULE.replace('version: "1.0.0"', `version: "${version}"`).replace(
      '"Hello from a plugin"',
      JSON.stringify(body)
    )
  })

  await seedPlugin(home, withLabel("1.0.0", "first version"))
  await openSession(window)
  await window.getByRole("button", { name: "E2E" }).click({ timeout: 15_000 })
  await expect(window.getByText("first version")).toBeVisible({ timeout: 15_000 })

  // Rewrite the module AND bump the version, exactly as `pnpm build` would.
  await seedPlugin(home, withLabel("1.0.1", "second version"))

  await expect(window.getByText("second version")).toBeVisible({ timeout: 20_000 })
  await expect(window.getByText("first version")).toHaveCount(0)
})

test("a host half can run a subprocess through ctx.exec", async ({ launchApp }) => {
  // `exec` had no e2e at all: the one host-half test returns a pure number. It is
  // the most security-sensitive thing a plugin can do — no shell, argv only, byte
  // caps, a timeout kill — and all of that was unit-tested in isolation while the
  // real path from a plugin's `activate` to a spawned process was never walked.
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
        tabs: [{ id: "e2e-tab.main", label: "E2E", when: "always" }],
        commands: [{ id: "e2e-tab.run", title: "Run" }]
      }
    }),
    ui: `
import { jsx, jsxs } from "react/jsx-runtime"
import { definePlugin, useHost } from "@jingler/plugin-sdk"
import { useEffect, useState } from "react"

function Tab() {
  const host = useHost()
  const [out, setOut] = useState("…")
  useEffect(() => {
    host.invoke("e2e-tab.run", {})
      .then((r) => setOut(String(r)))
      .catch((e) => setOut("error: " + String(e && e.message ? e.message : e)))
  }, [host])
  return jsxs("div", { children: [jsx("div", { "data-testid": "exec-out", children: out })] })
}

export default definePlugin(
  {
    id: "e2e-tab", name: "E2E Tab", version: "1.0.0", ui: "dist/ui.js", main: "dist/main.js",
    contributes: {
      tabs: [{ id: "e2e-tab.main", label: "E2E", when: "always" }],
      commands: [{ id: "e2e-tab.run", title: "Run" }]
    }
  },
  { views: { "e2e-tab.main": Tab } }
)
`
  })

  // `process.execPath` is the Electron binary; ELECTRON_RUN_AS_NODE makes it
  // behave as plain Node, so this needs no node on PATH and no shell.
  await writeFile(
    join(home, "jingler", "plugins", "e2e-tab", "dist", "main.js"),
    `export const activate = (ctx) => {
  ctx.subscriptions.push(
    ctx.commands.register("e2e-tab.run", async () => {
      const r = await ctx.exec(process.execPath, ["-e", "process.stdout.write('ran:' + (1+1))"], {
        env: { ELECTRON_RUN_AS_NODE: "1" }
      })
      // \`code\`, not \`exitCode\` — the field name the API digest got wrong.
      return r.stdout.trim() + "|code=" + r.code
    })
  )
}
`,
    "utf8"
  )

  await openSession(window)
  await window.getByRole("button", { name: "E2E" }).click({ timeout: 15_000 })
  await expect(window.getByTestId("exec-out")).toHaveText("ran:2|code=0", { timeout: 25_000 })
})

test("a valid manifest with a broken module explains itself in Settings", async ({
  launchApp
}) => {
  // The third failure category, between "manifest will not decode" and "the view
  // threw while rendering": the manifest is fine, the module loads, and it does
  // not export what it promised. The loader files this as a load error shown in
  // the plugin's own Settings row under a different testid that nothing asserted
  // — so the user got a missing tab and no explanation.
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [SESSION]
  })

  await seedPlugin(home, {
    // Declares a tab, ships no default export to satisfy it.
    ui: `export const notThePoint = 1\n`
  })

  await openPluginSettings(window)

  await expect(window.getByTestId("plugin-error-detail-e2e-tab")).toBeVisible({
    timeout: 15_000
  })
  // It is listed as an installed plugin, NOT as an undecodable folder — the
  // distinction the two code paths exist to draw.
  await expect(window.getByTestId("plugin-row-e2e-tab")).toBeVisible()
  await expect(window.getByTestId("plugins-undecodable")).toHaveCount(0)
})

test("declaring a keybinding fails loudly rather than doing nothing", async ({ launchApp }) => {
  // `contributes.keybindings` validates against the schema but is dispatched
  // nowhere. Accepting it would give an author a shortcut that never fires and no
  // reason why, so the loader refuses the plugin outright. That refusal is a
  // deliberate product decision and therefore worth a test — the tempting "fix"
  // for a confusing error is to make it silent again.
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [SESSION]
  })

  await seedPlugin(home, {
    manifest: manifest({
      contributes: {
        tabs: [{ id: "e2e-tab.main", label: "E2E", when: "always" }],
        keybindings: [{ command: "e2e-tab.main", key: "ctrl+alt+e" }]
      }
    })
  })

  await openPluginSettings(window)

  const detail = window.getByTestId("plugin-error-detail-e2e-tab")
  await expect(detail).toBeVisible({ timeout: 15_000 })
  await expect(detail).toContainText(/keybinding/i)

  // And it contributed nothing, rather than half-loading its tab.
  await window.getByRole("button", { name: "Close settings" }).click()
  await openSession(window)
  await expect(window.getByTestId("active-chat-tab")).toBeVisible({
    timeout: 15_000
  })
  await expect(window.getByRole("button", { name: "E2E" })).toHaveCount(0)
})

test("declaring untrusted-repo capabilities fails loudly, because nothing honours them", async ({
  launchApp
}) => {
  // The same rule as keybindings, applied to the one field where silence is
  // actively dangerous. `capabilities.untrustedRepos` is not a feature a plugin
  // wants — it is a promise a plugin MAKES about what it will not do in a repo
  // the operator has not trusted. Jingler has no trust model yet and mounts
  // those contributions anyway, so accepting the declaration would turn a safety
  // claim into decoration and mislead the most careful author hardest.
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [SESSION]
  })

  await seedPlugin(home, {
    manifest: manifest({
      capabilities: {
        untrustedRepos: {
          supported: "limited",
          restrictedContributions: ["e2e-tab.main"]
        }
      }
    })
  })

  await openPluginSettings(window)

  const detail = window.getByTestId("plugin-error-detail-e2e-tab")
  await expect(detail).toBeVisible({ timeout: 15_000 })
  await expect(detail).toContainText(/untrustedRepos/)

  await window.getByRole("button", { name: "Close settings" }).click()
  await openSession(window)
  await expect(window.getByTestId("active-chat-tab")).toBeVisible({
    timeout: 15_000
  })
  // Crucially the restricted contribution is NOT mounted. Loading the plugin and
  // ignoring the restriction is the failure this refusal exists to prevent.
  await expect(window.getByRole("button", { name: "E2E" })).toHaveCount(0)
})

test("a plugin built for a newer API is refused with a version, not a stack trace", async ({
  launchApp
}) => {
  // Checked BEFORE the module is imported, which is the whole point: evaluating a
  // future plugin's top-level code against an SDK missing what it expects
  // produces a stack trace from inside a bundle. The operator needs a sentence
  // naming the cause and the fix.
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [SESSION]
  })

  await seedPlugin(home, {
    manifest: manifest({ apiVersion: 99 }),
    // Deliberately a module that would THROW on import. If it is ever evaluated
    // the message would be this string rather than the version mismatch, so this
    // asserts the ordering rather than trusting it.
    ui: `throw new Error("this module must never be imported")\n`
  })

  await openPluginSettings(window)

  const detail = window.getByTestId("plugin-error-detail-e2e-tab")
  await expect(detail).toBeVisible({ timeout: 15_000 })
  await expect(detail).toContainText("plugin API v99")
  await expect(detail).not.toContainText("must never be imported")
})

/**
 * A host half that records the fact it ran, on disk.
 *
 * The point is to prove activation happened WITHOUT the UI invoking anything.
 * Every previous host-half test asserted on an `invoke` round-trip — and `invoke`
 * activates on the way past, so those tests passed whether or not
 * `activationEvents` were ever dispatched. A file written by `activate` is
 * observable from the test process with no plugin command involved.
 */
const RECORDING_MAIN = (marker: string) => `import { writeFileSync } from "node:fs"
export const activate = (ctx) => {
  writeFileSync(${JSON.stringify(marker)}, "activated", "utf8")
  ctx.subscriptions.push({ dispose: () => {} })
}
`

test("onTab activates the host half without the tab invoking anything", async ({
  launchApp
}) => {
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [SESSION]
  })

  const marker = join(home, "onTab-fired")

  await seedPlugin(home, {
    manifest: manifest({
      main: "dist/main.js",
      activationEvents: ["onTab:e2e-tab.main"],
      contributes: { tabs: [{ id: "e2e-tab.main", label: "E2E", when: "always" }] }
    }),
    // Renders from `session` alone. No `useHost`, no invoke — so nothing here can
    // activate the host half as a side effect.
    ui: `
import { jsx } from "react/jsx-runtime"
import { definePlugin, useSession } from "@jingler/plugin-sdk"

function Tab() {
  const session = useSession()
  return jsx("div", { "data-testid": "e2e-tab-repo", children: session.repo })
}

export default definePlugin(
  {
    id: "e2e-tab", name: "E2E Tab", version: "1.0.0", ui: "dist/ui.js", main: "dist/main.js",
    contributes: { tabs: [{ id: "e2e-tab.main", label: "E2E", when: "always" }] }
  },
  { views: { "e2e-tab.main": Tab } }
)
`
  })
  await writeFile(
    join(home, "jingler", "plugins", "e2e-tab", "dist", "main.js"),
    RECORDING_MAIN(marker),
    "utf8"
  )

  await openSession(window)
  await expect(window.getByRole("button", { name: "E2E" })).toBeVisible({ timeout: 15_000 })

  // Not activated yet: the tab exists but has never been opened, and lazy
  // activation is the whole point of declaring an event.
  expect(existsSync(marker)).toBe(false)

  await window.getByRole("button", { name: "E2E" }).click()
  await expect(window.getByTestId("e2e-tab-repo")).toHaveText("widget")

  await expect
    .poll(() => existsSync(marker), { timeout: 20_000 })
    .toBe(true)
})

test("onStartupFinished activates at boot, with no tab ever opened", async ({ launchApp }) => {
  // The event that could not fire at all: `activate()` was reachable only from
  // `invoke()`, which needs a command call, which needs UI. A plugin whose whole
  // job is to subscribe to session events in `activate` never ran a line.
  //
  // Dispatched by main after the host is installed, so it needs a relaunch
  // against a home that ALREADY has the plugin — seeding after launch would test
  // the watcher instead.
  const first = await launchApp({ configured: true, withRepo: true, sessions: [SESSION] })
  const marker = join(first.home, "onStartup-fired")

  await seedPlugin(first.home, {
    manifest: manifest({
      main: "dist/main.js",
      activationEvents: ["onStartupFinished"],
      // No tabs at all. There is no UI to open, which is the case that proves it.
      contributes: {}
    }),
    ui: `export default { manifest: { id: "e2e-tab" }, views: {}, panes: {} }\n`
  })
  await writeFile(
    join(first.home, "jingler", "plugins", "e2e-tab", "dist", "main.js"),
    RECORDING_MAIN(marker),
    "utf8"
  )
  await first.app.close()

  const second = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    configured: true,
    withRepo: true
  })
  await expect(second.window.getByTestId(`session-row-${SESSION.id}`)).toBeVisible({
    timeout: 15_000
  })

  await expect.poll(() => existsSync(marker), { timeout: 25_000 }).toBe(true)
})

test("a disabled plugin is not woken by onStartupFinished", async ({ launchApp }) => {
  // "Disabled" has to mean "runs no code" at every entry point, not most of them.
  // Startup dispatch iterates the catalog, so it is the one most likely to forget.
  const first = await launchApp({ configured: true, withRepo: true, sessions: [SESSION] })
  const marker = join(first.home, "disabled-fired")

  await seedPlugin(first.home, {
    manifest: manifest({
      main: "dist/main.js",
      activationEvents: ["onStartupFinished"],
      contributes: { tabs: [{ id: "e2e-tab.main", label: "E2E", when: "always" }] }
    })
  })
  await writeFile(
    join(first.home, "jingler", "plugins", "e2e-tab", "dist", "main.js"),
    RECORDING_MAIN(marker),
    "utf8"
  )

  await openPluginSettings(first.window)
  await expect(first.window.getByTestId("plugin-row-e2e-tab")).toBeVisible({ timeout: 15_000 })
  await first.window.getByLabel("Enable E2E Tab").click()
  await first.app.close()

  const second = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    configured: true,
    withRepo: true
  })
  await expect(second.window.getByTestId(`session-row-${SESSION.id}`)).toBeVisible({
    timeout: 15_000
  })

  // Give startup dispatch time to have got it wrong.
  await second.window.waitForTimeout(3_000)
  expect(existsSync(marker)).toBe(false)
})

test("declaring repoContains fails loudly — nothing matches globs against a repo", async ({
  launchApp
}) => {
  // The one activation event still unimplemented. `onStartupFinished`,
  // `onCommand:` and `onTab:` are all dispatched now; matching a glob against the
  // active session's repo needs a scanner nothing provides, so a plugin waiting
  // on it would wait forever.
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [SESSION]
  })

  await seedPlugin(home, {
    manifest: manifest({ activationEvents: ["repoContains:Cargo.toml"] })
  })

  await openPluginSettings(window)
  const detail = window.getByTestId("plugin-error-detail-e2e-tab")
  await expect(detail).toBeVisible({ timeout: 15_000 })
  await expect(detail).toContainText("repoContains")
})

test("a throwing dock pane shows a card instead of blanking the window", async ({
  launchApp
}) => {
  // There was no error boundary anywhere on the pane path — a comment claimed one
  // came from `session-split`, where `renderDock` is a bare div. So a pane with a
  // typo unwound to the root boundary and took the whole window, sessions and all.
  // The other pane test only reads props, so it could not catch this.
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [SESSION]
  })

  await seedPlugin(home, {
    id: "pane-plugin",
    manifest: {
      id: "pane-plugin",
      name: "Pane Plugin",
      version: "1.0.0",
      ui: "dist/ui.js",
      contributes: {
        panes: [{ id: "pane-plugin.side", label: "Side", slot: "right" }]
      }
    },
    ui: `
import { definePlugin } from "@jingler/plugin-sdk"
function Side() { throw new Error("pane exploded") }
export default definePlugin(
  {
    id: "pane-plugin", name: "Pane Plugin", version: "1.0.0", ui: "dist/ui.js",
    contributes: { panes: [{ id: "pane-plugin.side", label: "Side", slot: "right" }] }
  },
  { panes: { "pane-plugin.side": Side } }
)
`
  })

  await openSession(window)

  await expect(window.getByTestId("plugin-pane-error-pane-plugin")).toBeVisible({
    timeout: 15_000
  })
  await expect(window.getByText(/pane exploded/)).toBeVisible()

  // The app is intact — this is the assertion that failed before the boundary
  // existed, because the window was blank.
  await expect(window.getByTestId("active-chat-tab")).toBeVisible()
  await expect(window.getByTestId(`session-row-${SESSION.id}`)).toBeVisible()
})

test("SDK hooks work inside a dock pane, as the SDK documents", async ({ launchApp }) => {
  // Panes were never wrapped in a `PluginViewProvider`, so every hook threw
  // "called outside a Jingler plugin view" — in one of the two places the SDK
  // says hooks work.
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [SESSION]
  })

  await seedPlugin(home, {
    id: "pane-plugin",
    manifest: {
      id: "pane-plugin",
      name: "Pane Plugin",
      version: "1.0.0",
      ui: "dist/ui.js",
      contributes: {
        panes: [{ id: "pane-plugin.side", label: "Side", slot: "right" }]
      }
    },
    ui: `
import { jsx, jsxs } from "react/jsx-runtime"
import { definePlugin, useHost, usePluginStorage, useSessionOrNull } from "@jingler/plugin-sdk"
import { useEffect, useState } from "react"

function Side() {
  const host = useHost()
  const storage = usePluginStorage()
  const session = useSessionOrNull()
  const [stored, setStored] = useState("…")
  useEffect(() => {
    storage.set("pane", "wrote-from-pane")
      .then(() => storage.get("pane"))
      .then((v) => setStored(String(v)))
      .catch((e) => setStored("error: " + String(e && e.message ? e.message : e)))
  }, [storage])
  return jsxs("div", {
    children: [
      jsx("span", { "data-testid": "pane-bridge", children: typeof host.invoke === "function" ? "bridge ready" : "bridge missing" }),
      jsx("span", { "data-testid": "pane-session", children: session ? session.repo : "none" }),
      jsx("span", { "data-testid": "pane-stored", children: stored })
    ]
  })
}

export default definePlugin(
  {
    id: "pane-plugin", name: "Pane Plugin", version: "1.0.0", ui: "dist/ui.js",
    contributes: { panes: [{ id: "pane-plugin.side", label: "Side", slot: "right" }] }
  },
  { panes: { "pane-plugin.side": Side } }
)
`
  })

  await openSession(window)

  // No error card: the hooks resolved rather than throwing.
  await expect(window.getByTestId("pane-bridge")).toHaveText("bridge ready", { timeout: 15_000 })
  await expect(window.getByTestId("pane-session")).toHaveText("widget")
  // Storage round-trips from a pane, which needs the bridge the provider carries.
  await expect(window.getByTestId("pane-stored")).toHaveText("wrote-from-pane", {
    timeout: 20_000
  })
  await expect(window.getByTestId("plugin-pane-error-pane-plugin")).toHaveCount(0)
})

test("a plugin can unlink the session's issue, and the app sees it", async ({ launchApp }) => {
  // The built-in Issue tab offered "unlink"; the plugin that replaced it could
  // not, because the SDK had no session-mutating surface at all. The RPC and its
  // main-process handler survived the migration and `App.tsx` kept a callback
  // nothing referenced, so the capability was gone with nothing failing.
  //
  // What this asserts is the whole round trip, because each half was already
  // there and it was the JOIN that was missing: the hook reaches the RPC, main
  // writes the session, and the updated record gets republished into the app's
  // own state so the plugin's `useSession` sees it WITHOUT a reload. That last
  // step is the one a unit test cannot reach.
  const first = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [{ ...SESSION, issueNumber: 128 }]
  })
  const { window, home } = first

  await seedPlugin(home, {
    id: "unlink-plugin",
    manifest: {
      id: "unlink-plugin",
      name: "Unlink Plugin",
      version: "1.0.0",
      ui: "dist/ui.js",
      contributes: {
        tabs: [{ id: "unlink-plugin.issue", label: "Linked", icon: "CircleDot" }]
      }
    },
    ui: `
import { jsx, jsxs } from "react/jsx-runtime"
import { definePlugin, useSession, useSessionActions } from "@jingler/plugin-sdk"

function IssueTab() {
  const session = useSession()
  const { unlinkIssue } = useSessionActions()
  return jsxs("div", {
    children: [
      jsx("span", {
        "data-testid": "unlink-issue-number",
        children: session.issueNumber == null ? "none" : String(session.issueNumber)
      }),
      jsx("button", {
        type: "button",
        "data-testid": "unlink-go",
        onClick: () => { void unlinkIssue(session.id) },
        children: "Unlink"
      })
    ]
  })
}

export default definePlugin(
  {
    id: "unlink-plugin", name: "Unlink Plugin", version: "1.0.0", ui: "dist/ui.js",
    contributes: { tabs: [{ id: "unlink-plugin.issue", label: "Linked", icon: "CircleDot" }] }
  },
  { views: { "unlink-plugin.issue": IssueTab } }
)
`
  })

  await openSession(window)
  await window.getByRole("button", { name: "Linked" }).click({ timeout: 15_000 })

  // The snapshot carries the linked issue, so the tab has something to unlink.
  await expect(window.getByTestId("unlink-issue-number")).toHaveText("128", {
    timeout: 15_000
  })

  await window.getByTestId("unlink-go").click()

  // Live, with no reload: `session-updates` republished the record the RPC
  // returned, App.tsx forwarded it into `appMachine`, and the snapshot the hook
  // resolves was rebuilt from it. Without that republish this stays at 128 until
  // the app restarts, which looks exactly like the button doing nothing.
  await expect(window.getByTestId("unlink-issue-number")).toHaveText("none", {
    timeout: 15_000
  })
  await first.app.close()

  // And it is a real write rather than renderer state: same ~/jingler, nothing
  // re-seeded, so 128 coming back would mean the RPC never reached disk.
  const second = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    configured: true,
    withRepo: true
  })
  await second.window.getByTestId(`session-row-${SESSION.id}`).click()
  await second.window.getByRole("button", { name: "Linked" }).click({ timeout: 15_000 })
  await expect(second.window.getByTestId("unlink-issue-number")).toHaveText("none", {
    timeout: 15_000
  })
})

test("a failed install says why, instead of the picker closing on nothing", async ({
  launchApp
}) => {
  // Every settings callback returned a promise that the component invoked as
  // `void onX()`, so a rejection was an unhandled promise rejection in devtools.
  // On the install flow, where invalid input is the expected case, the operator
  // chose a folder and nothing whatsoever happened.
  const { window, app, home } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [SESSION]
  })

  // A directory with no manifest — the commonest mistake, picking the repo root
  // or a `src` folder rather than the built plugin.
  const notAPlugin = join(home, "downloads", "not-a-plugin")
  await mkdir(notAPlugin, { recursive: true })

  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = () =>
      Promise.resolve({ canceled: false, filePaths: [chosen] }) as never
  }, notAPlugin)

  await openPluginSettings(window)
  await window.getByTestId("plugin-install-folder").click()

  const error = window.getByTestId("plugin-action-error")
  await expect(error).toBeVisible({ timeout: 15_000 })
  await expect(error).toContainText("jingler.plugin.json")

  // And it can be dismissed, rather than sitting there for the session.
  await window.getByTestId("plugin-action-error-dismiss").click()
  await expect(error).toHaveCount(0)
})

test("a plugin declaring the CURRENT api version loads normally", async ({ launchApp }) => {
  // The other half of the gate, and the one that would break every plugin if the
  // comparison were `!==` rather than `>`: opting in must not cost anything.
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [SESSION]
  })

  await seedPlugin(home, { manifest: manifest({ apiVersion: 1 }) })

  await openSession(window)
  await expect(window.getByRole("button", { name: "E2E" })).toBeVisible({ timeout: 15_000 })
  await window.getByRole("button", { name: "E2E" }).click()
  await expect(window.getByTestId("e2e-tab-repo")).toHaveText("widget")
})

test("unlinking from a `when: hasIssue` tab removes that tab without breaking the pane", async ({
  launchApp
}) => {
  // The shipped github-issues tab declares `when: "hasIssue"`, so unlinking makes
  // the tab's OWN visibility condition false — the operator clicks a button and
  // the thing they clicked it in disappears. The other unlink test uses an
  // always-visible tab and would pass either way.
  //
  // The hazard is the pane being left pointing at a tab that no longer exists.
  // The github-issues plugin cannot be driven here (its tab needs a live GitHub
  // fetch before the button renders at all), so this reproduces the shape with a
  // synthetic plugin declaring the same `when`.
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [{ ...SESSION, issueNumber: 128 }]
  })

  await seedPlugin(home, {
    id: "hasissue-plugin",
    manifest: {
      id: "hasissue-plugin",
      name: "HasIssue Plugin",
      version: "1.0.0",
      ui: "dist/ui.js",
      contributes: {
        tabs: [
          {
            id: "hasissue-plugin.issue",
            label: "Linked",
            icon: "CircleDot",
            when: "hasIssue"
          }
        ]
      }
    },
    ui: `
import { jsx, jsxs } from "react/jsx-runtime"
import { definePlugin, useSession, useSessionActions } from "@jingler/plugin-sdk"

function IssueTab() {
  const session = useSession()
  const { unlinkIssue } = useSessionActions()
  return jsxs("div", {
    children: [
      jsx("span", { "data-testid": "hasissue-body", children: "linked" }),
      jsx("button", {
        type: "button",
        "data-testid": "hasissue-unlink",
        onClick: () => { void unlinkIssue(session.id) },
        children: "Unlink"
      })
    ]
  })
}

export default definePlugin(
  {
    id: "hasissue-plugin", name: "HasIssue Plugin", version: "1.0.0", ui: "dist/ui.js",
    contributes: {
      tabs: [{ id: "hasissue-plugin.issue", label: "Linked", icon: "CircleDot", when: "hasIssue" }]
    }
  },
  { views: { "hasissue-plugin.issue": IssueTab } }
)
`
  })

  await openSession(window)

  // The tab is there because the session has an issue — that is the `when`.
  await window.getByRole("button", { name: "Linked" }).click({ timeout: 15_000 })
  await expect(window.getByTestId("hasissue-body")).toBeVisible({ timeout: 15_000 })

  await window.getByTestId("hasissue-unlink").click()

  // The tab removes itself, because its own condition is now false.
  await expect(window.getByRole("button", { name: "Linked" })).toHaveCount(0, {
    timeout: 15_000
  })

  // And the pane falls back to a real tab rather than rendering nothing or a
  // boundary card — the failure this test exists for.
  await expect(window.getByTestId("active-chat-tab")).toBeVisible()
  await expect(window.getByTestId("plugin-error-hasissue-plugin")).toHaveCount(0)
})
