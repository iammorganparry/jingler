---
"@jingler/desktop": patch
"@jingler/cli-adapters": patch
"@jingler/ui": patch
---

Make agent-driven surfaces reliable in retained pi sessions. Tool callbacks (ask-question, submit-plan, permission gates) were captured once at pi-session creation, so every turn after the first emitted its interactive events into the previous turn's already-ended mailbox — the QuestionCard, Plan Review, and approval prompts never appeared while the run parked forever on an answer the operator could not see ("This chat is already running"). The retained-session registry now rebinds those callbacks to the current turn's context on every acquire. Plan Review also presents from the proposal itself (and from a gated revision), not only from the racy streamed-draft nonce, and the Fleet drawer learns about async subagent spawns from the tool acknowledgment plus a steady durable-status poll instead of depending solely on a bus event that can be missed.
