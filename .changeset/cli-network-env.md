---
"@jingler/desktop": patch
---

Agents now work behind corporate proxies and TLS inspection. Jingler passes your proxy, custom CA and mTLS settings (HTTPS_PROXY, NODE_EXTRA_CA_CERTS and similar) to Claude Code, Codex and opencode, and reads them from your login shell when Jingler was opened from the Dock. This fixes claude.ai connectors such as an Enterprise Slack connector failing with "fetch failed" in Jingler while working in the terminal.
