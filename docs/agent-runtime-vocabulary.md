# Agent runtime vocabulary

- **Runtime** — the engine Jingler talks to: PI, Claude Code, Codex, or OpenCode.
- **Endpoint** — one runtime installation or configured profile on one execution target. Endpoint IDs are target-namespaced.
- **Target** — the desktop or paired device where the endpoint process and credentials live.
- **Provider** — the model provider inside a runtime, such as Anthropic or OpenAI. OpenCode endpoints may expose several providers.
- **Model** — a provider model offered by one endpoint.
- **Continuation** — a runtime-owned session/thread ID tagged with its runtime and endpoint. It is invalid after a runtime, endpoint, or target switch.
- **Provider connection** — PI-only account, credential, certification, and billing-route state. PI projects provider connections into endpoints; native CLI runtimes do not use them.

The model picker selects an endpoint and model. Provider settings remain separate because changing an account or billing route is not the same operation as choosing an agent runtime.
