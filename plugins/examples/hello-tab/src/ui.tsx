import { useState } from "react"
import { definePlugin, usePluginStorage, type TabProps } from "@jingler/plugin-sdk"
import { manifest } from "./manifest.js"

/**
 * A tab that shows what the plugin can see about the current session, and
 * proves persistence works by counting visits.
 *
 * Every colour here is a `--sb-*` theme token (`bg-editor`, `text-text`,
 * `border-line`, …) rather than a literal — which is why this tab looks correct
 * in all nine bundled themes and in whatever the operator drops into
 * `~/jingler/themes` next. A hardcoded hex would survive a theme switch
 * unchanged, and on a light theme that means white text on white.
 */
function Greeting({ session }: TabProps) {
  const storage = usePluginStorage()
  const [visits, setVisits] = useState<number | null>(null)

  // Deliberately not a `useEffect`: this runs once per mount, and the tab
  // remounts each time the operator switches to it, which is exactly the
  // definition of a "visit" here.
  if (visits === null) {
    void storage.get<number>("visits").then(async (previous) => {
      const next = (previous ?? 0) + 1
      await storage.set("visits", next)
      setVisits(next)
    })
  }

  const facts: ReadonlyArray<readonly [string, string]> = [
    ["Repo", session.repo],
    ["Branch", session.branch],
    ["Agent", session.cli],
    ["Pull request", session.prNumber === null ? "none" : `#${session.prNumber}`],
    ["Worktree", session.worktreePath ?? "none"]
  ]

  return (
    <div
      data-testid="hello-tab-body"
      className="flex flex-1 flex-col gap-4 overflow-auto bg-editor p-6"
    >
      <div>
        <h2 className="text-[15px] font-semibold text-text">Hello from a plugin</h2>
        <p className="mt-1 text-[12.5px] leading-[1.6] text-dim">
          This tab is rendered by <code className="text-blue">hello-tab</code>, loaded
          from <code className="text-blue">~/jingler/plugins</code>. It shares the
          app&rsquo;s React and its theme tokens.
        </p>
      </div>

      <dl className="flex flex-col gap-px overflow-hidden rounded border border-line">
        {facts.map(([label, value]) => (
          <div key={label} className="flex items-baseline gap-3 bg-panel px-3 py-2">
            <dt className="w-28 flex-none text-[11.5px] uppercase tracking-wide text-dim">
              {label}
            </dt>
            <dd className="truncate font-mono text-[12.5px] text-text-body">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="text-[12.5px] text-dim">
        Opened{" "}
        <span data-testid="hello-tab-visits" className="font-mono text-green">
          {visits ?? "…"}
        </span>{" "}
        time{visits === 1 ? "" : "s"} — persisted by the host, so it survives a restart.
      </div>
    </div>
  )
}

export default definePlugin(manifest, {
  views: { "hello-tab.greeting": Greeting }
})
