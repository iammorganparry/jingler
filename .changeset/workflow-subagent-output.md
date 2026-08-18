---
"@jingler/desktop": patch
"@jingler/cli-adapters": patch
"@jingler/ui": patch
---

Surface workflow subagent output in the Fleet pane. A workflow run is an orchestrator with no pi session of its own, but it was projected as a lone transcript-less node: its steps were dropped once they completed (exactly when their transcripts exist), so opening it showed "the transcript is not available yet" forever and the root decayed to UNKNOWN when the process ended. The durable projection now renders the workflow root as a container with its steps nested beneath it — keeping completed steps selectable for their transcripts — the root settles to completed when every registered child finished, and the workflow node's own view now explains that its output lives in its step agents.
