---
"@jingler/desktop": patch
"@jingler/ui": patch
---

Add a stop button to running command tool calls (Bash and friends) in the transcript — a hung command that would otherwise block a turn for minutes can now be interrupted right from its card. It reuses the turn's stop, shown only while the command is running.
