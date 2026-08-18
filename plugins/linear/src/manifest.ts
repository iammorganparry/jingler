import { defineManifest } from "@jingler/plugin-sdk"

export const manifest = defineManifest({
  id: "linear",
  name: "Linear",
  version: "1.0.0",
  apiVersion: 1,
  description: "Create, link, and discuss Linear issues without leaving Jingler.",
  ui: "dist/ui.js",
  main: "dist/main.js",
  // Dormant until the operator opens the Issue tab. Issue-provider RPCs also
  // activate their declaring plugin before dispatch, so creating a session from
  // Linear remains race-free without starting the host half on every app boot.
  activationEvents: ["onTab:linear.issue"],
  contributes: {
    issueProviders: [{ id: "linear", label: "Linear" }],
    secretProfiles: [{
      id: "linear.accounts",
      label: "Linear accounts",
      description: "Named Linear personal API keys, encrypted by Jingler."
    }],
    tabs: [
      {
        id: "linear.issue",
        label: "Issue",
        icon: { asset: "dist/assets/linear-mark.svg", monochrome: true },
        order: 10,
        when: { issueProvider: "linear", includeUnlinked: true }
      }
    ],
    commands: [
      { id: "linear.configured", title: "Check Linear configuration", category: "Linear" },
      { id: "linear.context", title: "Load Linear workspace context", category: "Linear" },
      { id: "linear.list", title: "Search Linear issues", category: "Linear" },
      { id: "linear.get", title: "Fetch a Linear issue", category: "Linear" },
      { id: "linear.create", title: "Create a Linear issue", category: "Linear" },
      { id: "linear.comment", title: "Comment on a Linear issue", category: "Linear" },
      { id: "linear.configuration", title: "Load Linear account configuration", category: "Linear" },
      { id: "linear.profile-add", title: "Add a Linear account", category: "Linear" },
      { id: "linear.profile-remove", title: "Remove a Linear account", category: "Linear" },
      { id: "linear.repo-default", title: "Set repository Linear defaults", category: "Linear" },
      { id: "linear.session-override", title: "Override Linear for this session", category: "Linear" },
      { id: "linear.session-reset", title: "Reset the session Linear override", category: "Linear" }
    ],
    settings: [
      {
        id: "linear.api-key",
        label: "Personal API key",
        type: "secret",
        description: "Create a personal API key in Linear Security & access settings.",
        placeholder: "lin_api_…",
        validation: {
          pattern: "^lin_api_",
          message: "Linear personal API keys start with lin_api_."
        },
        documentationUrl: "https://linear.app/settings/api"
      }
    ]
  }
})
