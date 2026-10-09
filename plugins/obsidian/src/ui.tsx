import { definePlugin, useHost, type TabProps } from "@jingler/plugin-sdk"
import { atLeast, Button, Card, Input, Markdown, useWidthTier } from "@jingler/plugin-sdk/ui"
import { useMachine } from "@xstate/react"
import { manifest } from "./manifest.js"
import type { VaultChoice } from "./vault-choices.js"
import { notesMachine } from "./notes-machine.js"

function Notes(props: TabProps) {
  return <SessionNotes key={props.session.id} {...props} />
}
function SessionNotes({ session }: TabProps) {
  const host = useHost()
  const tier = useWidthTier()
  const stacked = !atLeast(tier, "mid")
  const [snapshot, send] = useMachine(notesMachine, { input: { services: {
    discover: () => host.invoke<VaultChoice[]>("obsidian.discover"),
    configuration: () => host.invoke<string>("obsidian.configuration", { sessionId: session.id }),
    configure: (root) => host.invoke<string>("obsidian.configure", { sessionId: session.id, root }),
    list: () => host.invoke<string[]>("obsidian.list", { sessionId: session.id }),
    read: (path) => host.invoke("obsidian.read", { sessionId: session.id, path })
  } } })
  const { root, configuredRoot, vaults, paths, note, error } = snapshot.context
  const busy = !snapshot.matches("ready")
  return <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto bg-editor p-4 text-text" data-testid="obsidian-notes">
    <header>
      <h2 className="text-lg font-semibold text-text-bright">Obsidian vault</h2>
      <p className="mt-1 text-sm text-dim">Read-only preview. Agents can update existing Markdown notes in this session's vault.</p>
    </header>
    <Card className="shrink-0 p-4">
      <h3 className="mb-2 text-sm font-semibold">Known Obsidian vaults</h3>
      <div className="flex max-h-48 flex-col gap-2 overflow-y-auto" data-testid="obsidian-vault-choices">
        {vaults.map((vault) => <Button key={vault.path} variant="secondary" className="h-auto justify-start whitespace-normal py-2 text-left" disabled={busy} aria-pressed={root === vault.path} onClick={() => send({ type: "ROOT", value: vault.path })}>
          <span className="min-w-0"><span className="block font-semibold">{vault.name}</span><span className="block break-all text-xs text-dim">{vault.path}</span></span>
        </Button>)}
        {!busy && !vaults.length && <p className="text-sm text-dim">No known vaults found. Enter a local directory below.</p>}
      </div>
      <form className="mt-4 flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); send({ type: "SAVE" }) }}>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">Vault path
          <Input value={root} disabled={busy} onChange={(event) => send({ type: "ROOT", value: event.target.value })} placeholder="Absolute local directory" />
        </label>
        <Button variant="secondary" type="submit" disabled={busy || !root}>Save vault</Button>
        <Button variant="ghost" disabled={busy || !configuredRoot} onClick={() => send({ type: "REFRESH" })}>Refresh notes</Button>
      </form>
      <p className="mt-2 text-xs text-dim">Select a known vault or enter an absolute path, then save to use it for this session.</p>
    </Card>
    {busy && <p role="status" className="text-sm text-dim">Loading vault…</p>}
    {error && <p role="alert" className="text-sm text-red">{error}</p>}
    <div className={`flex min-h-0 flex-1 gap-4 ${stacked ? "flex-col" : "flex-row"}`} data-testid="obsidian-browser-layout">
      <Card className={stacked ? "max-h-48 shrink-0" : "w-56 shrink-0"}>
        <nav aria-label="Vault notes" className="flex h-full flex-col gap-1 overflow-auto p-2">
          <h3 className="px-2 py-1 text-xs font-semibold text-dim">Notes · {paths.length}</h3>
          {paths.map((path) => <Button variant={note?.path === path ? "secondary" : "ghost"} size="sm" className="h-auto justify-start whitespace-normal break-all py-2 text-left" key={path} disabled={busy} aria-pressed={note?.path === path} onClick={() => send({ type: "SELECT", path })}>{path}</Button>)}
          {!busy && !error && !paths.length && <p className="p-2 text-sm text-dim">{configuredRoot ? "No Markdown notes to preview." : "Save a vault to browse its notes."}</p>}
        </nav>
      </Card>
      <Card className={stacked ? "min-h-64 flex-none" : "min-w-0 flex-1"}>
        <article className="h-full overflow-auto p-4" data-testid="obsidian-preview">
          {note ? <><h3 className="mb-4 break-all text-xs text-dim">{note.path}</h3><Markdown>{note.content}</Markdown></> : <p className="text-sm text-dim">{busy ? "Loading preview…" : "Choose a note to preview."}</p>}
        </article>
      </Card>
    </div>
  </div>
}
export default definePlugin(manifest, { views: { "obsidian.notes": Notes } })
