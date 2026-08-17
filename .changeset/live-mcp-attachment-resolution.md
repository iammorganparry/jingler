---
"@jingler/cli-adapters": patch
---

Resolve MCP attachment endpoints at call time in retained pi sessions. The browser MCP attachment is a per-run lease — a fresh loopback port and bearer whose listener closes with the run's scope — but MCP tools were registered once at pi-session creation with that first lease baked in, so every turn after the first dialled a dead endpoint and failed with "Could not connect to MCP server jingler-browser". Jingler-owned MCP sources now carry a live resolver that reads the current turn's attachments through the rebindable runtime context.
