import { defineManifest } from "@jingler/plugin-sdk"

export const manifest = defineManifest({
  id: "linear",
  name: "Linear",
  version: "1.0.0",
  apiVersion: 1,
  description: "Create, link, and discuss Linear issues without leaving Jingler.",
  ui: "dist/ui.js",
  main: "dist/main.js",
  activationEvents: ["onStartupFinished"],
  contributes: {
    issueProviders: [{ id: "linear", label: "Linear" }],
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
      { id: "linear.comment", title: "Comment on a Linear issue", category: "Linear" }
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
