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
Enumeration visits at most 10,000 entries (including hidden entries) and 20
directory levels; notes are limited to 1 MB of valid UTF-8. Unsupported names,
special files, symlinks, and entries that vanish during listing are skipped.

Select the **Obsidian vault** agent toolset for the session:

- `obsidian_list {offset?}` returns a bounded page of relative paths, vault,
  total count, and `nextOffset` (null at the end).
- `obsidian_read {path, offset?, revision?}` returns a bounded content page,
  vault, raw-byte SHA-256 revision, total UTF-16 length, and `nextOffset`. Offsets
  count UTF-16 code units. Follow `nextOffset` until null and concatenate pages;
  supply the first page's revision on later reads to reject changed notes.
- `obsidian_write {path, content, revision, vault}` replaces an existing note
  only if the vault and revision still match. Read every page before writing.
  On conflict, restart reading from offset 0. The result contains the new
  revision, not a redundant copy of the note.

Agents cannot change configuration or create/delete notes through this toolset.
Writes reject traversal, symlinks, special files, and hard links. They stage and
sync a same-directory temporary file, preserve permission bits, then revalidate
the destination inode, raw-byte revision, and session configuration immediately
before atomic replacement. Failed staging preserves the original; queued writes
are invalidated by vault configuration changes. Plugin writes are serialized.
Local filesystems have no portable atomic compare-and-swap: an external writer
changing a file between final validation and replacement can still race. Node's
path-based checks also cannot prevent a hostile local process
from swapping a parent directory for a symlink between checks; do not use a
vault writable by an untrusted local process as a security boundary. Avoid
simultaneous edits to the same note. Atomic replacement prevents mixed old/new
bytes, but does not promise power-loss durability or preserve extended ACLs.
An abrupt process exit before replacement can leave a hidden staging file.
This plugin is not a backup or synchronization service.

Run `pnpm --filter @jingler/plugin-obsidian test` and `typecheck` for host/vault
and state-machine behavior; `pnpm --filter @jingler/desktop e2e obsidian-plugin.spec.ts`
drives the built plugin through real Electron.
