---
"@jingler/desktop": patch
---

Fixed a crash where a diff with a malformed hunk showed a global "parsePatchContent: Invalid hunk" error. Jingler now renders whatever part of the diff it can instead.
