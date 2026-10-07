import { definePlugin, useHost, type TabProps } from "@jingler/plugin-sdk"
import { Markdown } from "@jingler/plugin-sdk/ui"
import { useMachine } from "@xstate/react"
import { manifest } from "./manifest.js"
import { notesMachine } from "./notes-machine.js"

function Notes(props: TabProps) {
  return <SessionNotes key={props.session.id} {...props} />
}
function SessionNotes({ session }: TabProps) {
  const host = useHost()
  const [snapshot, send] = useMachine(notesMachine, { input: { services: {
    configuration: () => host.invoke<string>("obsidian.configuration", { sessionId: session.id }),
    configure: (root) => host.invoke<string>("obsidian.configure", { sessionId: session.id, root }),
    list: () => host.invoke<string[]>("obsidian.list", { sessionId: session.id }),
    read: (path) => host.invoke("obsidian.read", { sessionId: session.id, path })
  } } })
  const { root, paths, note, error } = snapshot.context
  const busy = !snapshot.matches("ready")
  return <div className="flex flex-1 flex-col gap-3 overflow-auto bg-editor p-4 text-text" data-testid="obsidian-notes">
    <h2>Obsidian vault</h2>
    <p className="text-dim">Read-only preview. Agents can update existing Markdown notes in this session's vault.</p>
    <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); send({ type: "SAVE" }) }}>
      <label className="flex flex-1 flex-col">Vault path
        <input className="rounded border border-line bg-panel p-2 text-text" value={root} disabled={busy} onChange={(event) => send({ type: "ROOT", value: event.target.value })} placeholder="Absolute local directory" />
      </label>
      <button type="submit" disabled={busy || !root}>Save vault</button>
      <button type="button" disabled={busy || !root} onClick={() => send({ type: "REFRESH" })}>Refresh notes</button>
    </form>
    {busy && <p role="status">Loading vault…</p>}
    {error && <p role="alert" className="text-red">{error}</p>}
    <div className="flex flex-1 gap-4 overflow-auto">
      <nav aria-label="Vault notes" className="flex w-56 shrink-0 flex-col gap-2 overflow-auto">
        {paths.map((path) => <button className="text-left text-blue" type="button" key={path} disabled={busy} aria-pressed={note?.path === path} onClick={() => send({ type: "SELECT", path })}>{path}</button>)}
        {!busy && !error && !paths.length && <p className="text-dim">No Markdown notes to preview.</p>}
      </nav>
      <article className="flex-1 overflow-auto" data-testid="obsidian-preview">
        {note && <><h3 className="text-dim">{note.path}</h3><Markdown>{note.content}</Markdown></>}
      </article>
    </div>
  </div>
}
export default definePlugin(manifest, { views: { "obsidian.notes": Notes } })
