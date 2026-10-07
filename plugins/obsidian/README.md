# Obsidian

The official Jingler plugin for local Obsidian vaults. Obsidian stores notes as
plain-text `.md` files; no Obsidian account, API, network request, or running
Obsidian process is needed.

Build with `pnpm --filter @jingler/plugin-obsidian build`. Install this folder
from Settings → Plugins, or copy `jingler.plugin.json` and `dist/` into
`~/jingler/plugins/obsidian/`. Open a session's **Obsidian** tab and save an
absolute vault directory. The validated path is persisted in plugin storage
for that session and read by the host. Each session has its own vault selection.
Use the canonical path: symlinks in the root or note path are rejected.

The tab browses and renders Markdown using Jingler's renderer. It never edits
notes. **Refresh notes** picks up external changes. Standard Markdown is
supported; Obsidian-specific wikilinks, embeds, and extensions are not resolved.
Hidden directories (including `.obsidian`) and non-Markdown files are excluded.
Listings are limited to 10,000 entries and 20 directory levels; notes to 1 MB.

Select the **Obsidian vault** agent toolset for the session:

- `obsidian_list {}` returns relative note paths and the configured vault.
- `obsidian_read {path}` returns content, vault, and SHA-256 revision.
- `obsidian_write {path, content, revision, vault}` replaces an existing note
  only if the vault and revision still match. Read again on conflict.

Agents cannot change configuration or create/delete notes through this toolset.
Writes reject traversal, symlinks, special files, and hard links; they use a
validated open descriptor and serialize plugin writes. A revision precondition
detects edits made since reading. Local filesystems have no portable atomic
compare-and-swap: an external writer changing a file during the final write can
still race. Node's path-based checks also cannot prevent a hostile local process
from swapping a parent directory for a symlink between checks; do not use a
vault writable by an untrusted local process as a security boundary. Avoid
simultaneous edits to the same note; writes are in place and are not
crash-atomic. This plugin is not a backup or synchronization service.

Run `pnpm --filter @jingler/plugin-obsidian test` and `typecheck` for host/vault
and state-machine behavior; `pnpm --filter @jingler/desktop e2e obsidian-plugin.spec.ts`
drives the built plugin through real Electron.
