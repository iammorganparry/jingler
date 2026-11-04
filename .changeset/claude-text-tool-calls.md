---
"@jingler/cli-adapters": patch
---

Claude models no longer print question (or other tool-call) JSON into the chat. When a model writes a tool call as text, Jingler now runs it as a real call, so the question card renders.
