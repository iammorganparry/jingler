# Plugins: permissions and trust

Read this before installing a plugin, and before writing one.

## Plugins are trusted code

Jingler plugins are **not sandboxed**. This is the same position VS Code takes
with extensions, and it is a deliberate choice rather than an unfinished one.

Concretely:

- A plugin's **UI half** is an ES module loaded into the renderer's own realm. It
  shares the app's React and can draw anything the app can draw.
- A plugin's **host half** is Node, running in a `utilityProcess` with the same
  filesystem and network access Jingler itself has.

Install plugins you trust, from sources you trust. Settings › Plugins says this
too, because that is the screen where the decision is actually made.

## What the boundaries are actually for

Several things in the design look like a sandbox and are not. Being precise
about what each one buys is more useful than a reassuring summary.

| Boundary | What it actually protects |
|---|---|
| Extension host is a separate process | Jingler from a plugin that hangs or crashes — not you from the plugin |
| `script-src 'self' jingler-plugin:` | The app from remote code. Plugin code is served only from `~/jingler/plugins` |
| `connect-src` unwidened | Nothing a determined plugin cannot route around via its host half — it stops *accidental* renderer network access |
| Path confinement + `realpath` | The protocol handler from serving files outside the plugins root, including via symlink |
| Lazy activation | Your startup time, and your CPU. Not your data |
| Consent-gated credentials | **This one is real.** See below |

The honest summary: the process boundary protects *Jingler* from plugins, and
the credential boundary protects *your accounts* from plugins. Neither protects
your machine from a plugin you chose to install.

## There is no `permissions` array

A Jingler manifest has no `permissions: ["github", "network"]` field. Do not
look for one; it was considered and rejected.

A coarse flag answers "may this plugin access GitHub?" — but the question an operator
actually has is *"which account, with which scopes, and can I take it back?"*
A flag can express none of those. Worse, a `permissions` list is read once at
install time, when the operator has the least context about what the plugin will
do, and never again.

## What happens instead

A plugin asks at the moment it needs access:

```ts
const session = await ctx.authentication.getSession("github", ["repo"])
```

You see a native dialog naming **that plugin**, **that provider** and **those
exact scopes**. Your answer is recorded, and you can revoke it in
Settings › Plugins › Granted access.

Four properties make that a real bargain rather than a ceremony, and each is
covered by a test:

1. **A repeat ask does not re-prompt.** Consent is not a nag.
2. **A wider ask DOES re-prompt.** A plugin granted `repo` cannot quietly begin
   asking for `admin:org`.
3. **Declining records nothing.** A refusal is not an answer that sticks.
4. **Revoking actually forgets.** The next ask prompts again. Uninstalling
   revokes everything that plugin held — deleting a plugin is the strongest
   revocation gesture there is, so reinstalling must not silently restore access.

### Why the prompt is a native dialog

It is the only modal in Jingler that is not React. Plugin UI runs in the
renderer's own realm and can draw anything the app can draw — so a consent
prompt rendered *there* is one a plugin could obscure, mimic or race. A native
modal is drawn by the OS and cannot be touched from the renderer.

"Allow" is also not the default button. The default is what someone hits by
reflex when a dialog appears over what they were doing, and reflex is the
opposite of consent.

### Tokens never reach the renderer

A granted token lives in the extension host. `AuthSessionInfo` — the shape every
`Plugins.*` RPC returns — has no token field at all, so there is no route by
which a log line, a crash report or a devtools inspection in the renderer can
leak one.

### GitHub credentials

The built-in `github` provider uses a short-lived credential issued for the
repositories selected on the user's Jingler GitHub App installation. It does not
discover or borrow a GitHub CLI token. The credential stays in the extension
host, expires naturally, and is never returned to plugin UI.

The scopes a plugin requests remain the operator-facing consent boundary. GitHub
also enforces the GitHub App's configured permissions and selected-repository
boundary; a plugin cannot use this provider to reach a repository outside the
installation or obtain organization-administration access.

A third-party plugin is trusted native code and may independently launch any
installed subprocess, including `gh`. That is outside Jingler's credential
provider and is another reason to install only plugins whose source you trust.

## No privileged plugins

The GitHub Issues plugin ships with Jingler and still calls
`getSession("github", ["repo"])` like anything else. There is no back door for
official plugins, and there is no allowlist.

This is deliberately testable rather than merely asserted: if an official plugin
could skip consent, the API would be decorative, and the first third-party
plugin author to look would find out.

## Session mutations are not consent-gated

A plugin can detach a session's linked issue — `useSessionActions().unlinkIssue`
— and nothing prompts. That is a deliberate reading of the risk rather than an
oversight: the action is trivially reversible, re-linking is available through
the same plugin, and no credential or data leaves the machine. Putting a native
dialog in front of it would train operators to click through dialogs, which is
the one thing that would make the `getSession` prompt above worth less.

It is still a mutation, and it is the only one. If this list ever grows past
"reversible in one click", it needs the consent machinery, not a bigger
paragraph here.

## For plugin authors

- Handle a declined prompt. `getSession` **rejects** when the operator says no
  (matching VS Code). Pass `{ createIfNone: false }` to ask without prompting;
  that resolves `undefined` when there is no existing grant.
- Ask for the narrowest scopes that work. You will be asked again if you widen,
  and an operator who sees a second prompt for `admin:org` will think about it.
- Do not try to move a token to your UI half. There is no route, by design.

## See also

- `packages/plugin-sdk/AGENTS.md` — the complete authoring contract
- `packages/plugin-sdk/api-digest.md` — every export, one page
- `packages/core/src/plugin.ts` — the manifest schema and the reasoning behind it
