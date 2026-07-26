/**
 * The worked example from `AGENTS.md`, compiled.
 *
 * Documentation that does not compile is worse than no documentation: an agent
 * or an author follows it exactly, gets a type error, and now distrusts every
 * other line on the page. This file is the same plugin as the one in AGENTS.md,
 * so a change to the SDK that would invalidate the docs fails the build instead
 * of shipping.
 *
 * Kept as `.test-d.tsx` — typechecked, never executed.
 */
import { useEffect, useState } from "react"
import { definePlugin, defineManifest, useHost, type TabProps } from "./index.js"
import type { Activate } from "./host.js"

interface Issue {
  id: string
  title: string
}

// ── src/manifest.ts ──────────────────────────────────────────────────────────

export const manifest = defineManifest({
  id: "linear",
  name: "Linear",
  version: "1.0.0",
  ui: "dist/ui.js",
  main: "dist/main.js",
  activationEvents: ["onTab:linear.issues"],
  contributes: {
    tabs: [{ id: "linear.issues", label: "Issues", icon: "CircleDot" }],
    commands: [{ id: "linear.sync", title: "Sync Linear" }]
  }
})

// ── src/ui.tsx ───────────────────────────────────────────────────────────────

function IssuesTab({ session }: TabProps) {
  const host = useHost()
  const [issues, setIssues] = useState<Issue[]>([])

  useEffect(() => {
    void host.invoke<Issue[]>("linear.sync", { repo: session.repo }).then(setIssues)
  }, [host, session.repo])

  return (
    <div className="flex-1 overflow-auto bg-editor p-4">
      <h2 className="text-[15px] font-semibold text-text">{session.repo}</h2>
      <ul className="mt-3 flex flex-col gap-1">
        {issues.map((issue) => (
          <li key={issue.id} className="rounded border border-line px-3 py-2 text-text-body">
            {issue.title}
          </li>
        ))}
      </ul>
    </div>
  )
}

export default definePlugin(manifest, {
  views: { "linear.issues": IssuesTab }
})

// ── src/main.ts ──────────────────────────────────────────────────────────────

export const activate: Activate = async (ctx) => {
  ctx.subscriptions.push(
    ctx.commands.register("linear.sync", async (arg) => {
      const { repo } = arg as { repo: string }

      const session = await ctx.authentication.getSession("github", ["repo"])
      if (!session) return []

      const res = await fetch(`https://api.example.com/issues?repo=${repo}`, {
        headers: { authorization: `Bearer ${session.accessToken}` }
      })
      return (await res.json()) as Issue[]
    })
  )
}
