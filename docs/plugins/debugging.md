# Debugging a plugin

Your plugin has two halves running in two processes, and they fail in different
places. This page is the map: **where each kind of failure shows up**, and what
to do about it.

Read the first table, find your symptom, go to that section.

| Symptom | Where the explanation is | Section |
|---|---|---|
| Tab or pane never appears | Settings › Plugins, your plugin's row | [Load failures](#load-failures) |
| Plugin missing from Settings entirely | Settings › Plugins, "Could not be read" | [Manifest failures](#manifest-failures) |
| Tab appears, shows a yellow error card | The card itself, plus renderer devtools | [Render failures](#render-failures) |
| `host.invoke(...)` rejects | The terminal running `pnpm dev` | [Host-half failures](#host-half-failures) |
| Your edit does nothing | You did not bump `version` | [Nothing changed](#my-edit-did-nothing) |

---

## The one-line summary

- **UI half** → renderer devtools (`Cmd+Opt+I` / `Ctrl+Shift+I`), like any web app.
- **Host half** → the **terminal running `pnpm dev`**, because the extension host
  forwards its output there.
- **Anything that stopped the plugin loading** → **Settings › Plugins**, in the row.

Starbase never fails a plugin silently. If you are getting nothing at all with no
message anywhere, that is a bug in Starbase — please report it, because the whole
loader is built so that cannot happen.

---

## Load failures

*Symptom: no tab, no pane, no error card. Settings lists the plugin.*

Open **Settings › Plugins**. A plugin that loaded but contributed nothing shows a
yellow message inline in its own row. The message is the real one, not a summary,
because a summary throws away the line number that makes it fixable.

The messages you will actually hit:

| Message | What happened |
|---|---|
| `declares N UI contribution(s) but no \`ui\` entry` | Your manifest has `contributes.tabs` or `.panes` but no `ui` field. |
| `could not load dist/ui.js: …` | The module threw while being imported, or the file is not there. Check `dist/` exists and you ran `pnpm build`. |
| `its UI module exports no default` | Your entry is missing `export default definePlugin(...)`. |
| `declares the tab "x" but its UI module exports no matching view` | The manifest and the `views` map disagree. |
| `declares the pane "x" but its UI module exports no matching pane component` | Panes go in the **`panes`** key of `definePlugin`, not `views`. |
| `contributes.keybindings — not supported in this build` | Real. Keybinding and settings contributions validate but are dispatched by nothing yet, so the loader refuses rather than letting you ship a shortcut that never fires. Remove it. |
| `entry-missing` (in "Could not be read") | The manifest names a `ui`/`main` file that is not on disk. Almost always a forgotten `pnpm build`. |

## Manifest failures

*Symptom: your plugin is not in the Settings list at all.*

Scroll to **"Could not be read"** in Settings › Plugins. A folder whose
`starbase.plugin.json` cannot be decoded is listed there with the decoder's
verbatim complaint, including the path into the JSON that was wrong.

Two things that are *not* failures and produce no entry:

- a directory with **no** `starbase.plugin.json` in the app's own bundled plugin
  root — that is a container, not a broken plugin;
- a plugin you have **disabled** — it stays in the main list with its switch off.

## Render failures

*Symptom: the tab appears, and clicking it shows a bordered error card naming
your plugin.*

Your component threw while rendering. The card shows the message; the stack is in
**renderer devtools**:

```
View › Toggle Developer Tools      (or Cmd+Opt+I / Ctrl+Shift+I)
```

The card is contained on purpose — the rest of Starbase keeps working, and the
other tabs are unaffected. It clears by itself when the subtree beneath it is
replaced, so **fixing your plugin and rebuilding makes the card go away** without
a restart.

The single most common cause, and the one that will not reproduce on your
machine: **you bundled React.** See [the React rule](#the-react-rule).

## Host-half failures

*Symptom: `host.invoke("...")` rejects, or your `activate` never runs.*

The extension host is a separate Node process. Its output is inherited by the
main process, so **everything it prints goes to the terminal you ran `pnpm dev`
in** — not to renderer devtools.

Both of these land there:

```ts
ctx.log.info("fetching issues")   // tagged: [plugin:my-plugin] fetching issues
console.log("raw")                // plain, via inherited stdio
```

Prefer `ctx.log` — it is tagged with your plugin id, so it is findable when three
plugins are talking at once.

Failures Starbase prints for you:

```
[plugin:my-plugin] activation failed: <the error your activate threw>
```

Things worth knowing when a host half misbehaves:

- **`activate` runs on your declared `activationEvents`, not at startup.** A
  plugin with no `activationEvents` never starts a process at all — Settings says
  "no background process" in its row. If your `activate` is not running, check
  that first.
- **All plugins share one host process.** A crash takes every plugin's host half
  down with it. Starbase restarts it once and re-activates; a plugin that crashes
  again immediately is left down rather than looped. A minute of healthy uptime
  forgives the budget.
- **`ctx.exec` gives you `code`, not `exitCode`.** Reading the wrong field yields
  `undefined`, which is falsy, so a failed command reads as a success.
- **`ctx.exec`'s `cwd` defaults to the host process's directory**, which is not
  your repo and not the session's worktree. Pass `session.worktreePath`
  explicitly for anything repo-shaped.

## My edit did nothing

Almost always one of these three, in order of likelihood:

1. **You did not bump `version`.** ES module imports are cached by URL for the
   life of the window. Starbase keys your module by the manifest version, so the
   version is what busts that cache. Same version, same module, no matter how
   many times you rebuild.

2. **You did not re-run `install:local`.** Starbase watches
   `~/starbase/plugins`, not your source tree. Building into `plugins/my-plugin/dist`
   changes nothing until it is copied across. The full loop is
   `pnpm build && pnpm install:local`.

3. **You edited the manifest but not the built one.** `starbase.plugin.json` is
   *generated* from `src/manifest.ts` by `pnpm build`. Editing the JSON directly
   works until the next build overwrites it.

With all three right, the reload is live — no restart, no reopening the session.

## The React rule

`@starbase/plugin-sdk/vite` externalises `react`, `react-dom`,
`react/jsx-runtime`, `react/jsx-dev-runtime`, `@starbase/plugin-sdk` and
`@starbase/plugin-sdk/ui`. Starbase supplies all six at runtime.

If you bundle React anyway, **your plugin works perfectly until a second plugin
is installed**, and then every hook in both throws `Invalid hook call`. You will
have tested it, shipped it, and be unable to reproduce the bug that follows.

Check your output before you publish:

```bash
grep -c "useState" dist/ui.js     # your calls only — a bundled React is thousands of lines
```

## Getting a clean slate

```bash
# Which plugins does Starbase actually see?
ls ~/starbase/plugins

# Start over without touching your real setup: point STARBASE_HOME somewhere else.
STARBASE_HOME=/tmp/starbase-scratch pnpm --filter @starbase/desktop dev
```

`STARBASE_HOME` moves the whole `~/starbase` tree — config, sessions, plugins,
plugin storage. It is what the e2e suite uses, and it is the fastest way to prove
a problem is your plugin rather than your existing state.

To clear just your plugin's stored data, uninstall it in Settings and reinstall;
storage is keyed by plugin id.
