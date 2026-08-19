---
"@jingler/desktop": patch
---

Fix "This chat is already running" when you stop a running tool and immediately send a queued message. The stop emits its terminal "Stopped." event but now also marks the turn settled right away, so the next send is admitted instead of racing the interrupted turn's unwind.
