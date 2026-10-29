import { definePlugin, useSession, type TabProps } from "@jingler/plugin-sdk"
// The themed kit is a separate entrypoint so Node-side build scripts can import
// the root without pulling the component library in.
import { cn } from "@jingler/plugin-sdk/ui"
import { manifest } from "./manifest.js"

/**
 * Every colour here is a `--sb-*` theme token — `bg-editor`, `text-text`,
 * `border-line` — never a hex. A literal colour survives a theme switch
 * unchanged, which on a light theme means white text on white.
 */
function SlackTab({ session }: TabProps) {
  // `session` is also available anywhere below via `useSession()`.
  void useSession

  return (
    <div className={cn("flex flex-1 flex-col gap-3 overflow-auto bg-editor p-6")}>
      <h2 className="text-[15px] font-semibold text-text">Slack</h2>
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
  views: { "slack.main": SlackTab }
})
