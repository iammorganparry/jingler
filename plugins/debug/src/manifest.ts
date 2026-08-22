import { defineManifest } from "@jingler/plugin-sdk"

export const manifest = defineManifest({
  id: "debug",
  name: "Debug",
  version: "1.0.0",
  apiVersion: 1,
  description: "Debug programs with DAP while Jingler follows live execution in Files.",
  main: "dist/main.js",
  capabilities: {
    untrustedRepos: {
      supported: "limited",
      description: "Debug adapters execute repository programs and configuration.",
      restrictedContributions: ["debug.dap", "debug.snapshot", "debug.control", "debug.hover"]
    }
  },
  contributes: {
    agentToolsets: [{
      id: "debug.dap",
      label: "Debugger",
      description: "Launch or attach a DAP debugger, then inspect breakpoints, runtime state, memory, and threads."
    }],
    commands: [
      { id: "debug.snapshot", title: "Read debugger state", category: "Debug" },
      { id: "debug.control", title: "Control debugger", category: "Debug" },
      { id: "debug.hover", title: "Evaluate hovered identifier", category: "Debug" }
    ]
  }
})
