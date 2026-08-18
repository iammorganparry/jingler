---
"@jingler/desktop": patch
"@jingler/cli-adapters": patch
"@jingler/contracts": patch
---

Unblock queued GitHub feedback during long tool calls and stop workflow headers accumulating in the Fleet. "Send now" on queued external feedback now interrupts the turn and replays it through Agent.run (which is the durable identity-acceptance boundary, so relay replay stays idempotent) — previously the button was dead while a long-running tool held the turn. A renderer fast-refresh no longer fires a held message into a chat whose previous turn is still streaming in main (which returned only the single-flight refusal as its reply): the load now asks main whether the chat is busy via the new `Agent.chatBusy` RPC and holds the queue until the live turn settles. Settled foreground workflow runs now leave the Fleet dock exactly as async completions do (their finished children stay reachable through the completed-agents retention), and a refresh sweep clears never-settling workflow headers left behind by dead runs.
