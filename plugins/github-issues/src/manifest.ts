import { defineManifest } from "@starbase/plugin-sdk"

/**
 * The GitHub Issues tab, as an official plugin.
 *
 * ## Why this one and not Pull Requests
 *
 * Pull Requests stays first-class: it drives session archiving, close-on-merge
 * and notifications, which are app behaviour rather than tab behaviour, and
 * pretending otherwise would mean inventing host APIs for session mutation that
 * nothing else has asked for.
 *
 * Issues is the honest slice. It is a self-contained tab over data the app fetches
 * anyway, and it has an obvious sibling — a Linear plugin contributing the same
 * shape of tab from a different service. That pair is the actual proof that
 * "extend the app with your favourite apps" is real: two plugins, one
 * contribution point, neither of them privileged.
 *
 * ## Why it has a host half
 *
 * The tab needs GitHub. The renderer's CSP means a plugin's UI half cannot reach
 * the network at all, so the fetch lives in `main.ts` — and reaches GitHub
 * through `authentication.getSession("github", …)`, the same consent-gated door
 * a third-party plugin would use. There is no shortcut for being official.
 */
export const manifest = defineManifest({
  id: "github-issues",
  name: "GitHub Issues",
  version: "1.0.0",
  description: "Read the issue linked to a session, without leaving Starbase.",
  ui: "dist/ui.js",
  main: "dist/main.js",
  // Dormant until the operator actually opens the tab. A session with no linked
  // issue never shows it, so most sessions never start this plugin at all.
  activationEvents: ["onTab:github-issues.issue"],
  contributes: {
    tabs: [
      {
        id: "github-issues.issue",
        label: "Issue",
        icon: "CircleDot",
        // Sorts where the built-in Issue tab used to, so the migration is
        // invisible to anyone who was already using it.
        order: 10,
        when: "hasIssue"
      }
    ],
    commands: [
      {
        id: "github-issues.fetch",
        title: "Fetch linked issue",
        category: "GitHub"
      }
    ]
  }
})
