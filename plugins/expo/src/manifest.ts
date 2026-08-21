import { defineManifest } from "@jingler/plugin-sdk"

export const manifest = defineManifest({
  id: "expo",
  name: "Expo",
  version: "1.0.0",
  apiVersion: 1,
  description: "View a local Expo app running in the iOS Simulator.",
  ui: "dist/ui.js",
  main: "dist/main.js",
  activationEvents: ["onTab:expo.preview"],
  contributes: {
    tabs: [
      {
        id: "expo.preview",
        label: "Expo",
        icon: "Smartphone",
        when: "hasWorktree"
      }
    ],
    agentToolsets: [
      {
        id: "expo.ios-preview",
        label: "Expo iOS preview",
        description: "Open and control the current worktree's Expo app in iOS Simulator."
      }
    ],
    commands: [
      { id: "expo.inspect", title: "Check iOS preview requirements", category: "Expo" },
      { id: "expo.start", title: "Start iOS preview", category: "Expo" },
      { id: "expo.status", title: "Read iOS preview status", category: "Expo" },
      { id: "expo.frame", title: "Capture iOS preview frame", category: "Expo" },
      { id: "expo.reload", title: "Reload Expo app", category: "Expo" },
      { id: "expo.stop", title: "Stop iOS preview", category: "Expo" },
      { id: "expo.open-simulator", title: "Open iOS Simulator", category: "Expo" }
    ]
  }
})
