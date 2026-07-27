---
"@jingler/cli-adapters": patch
"@jingler/desktop": patch
---

Stop a reloaded window from wedging a chat on "already running"

A chat could refuse every message forever with "This chat is already running.
Wait for it to finish or stop it before sending again." — with nothing running,
and no stop button on screen to clear it. Quitting and reopening the app was the
only way out.

The run reservation that backs single-flight is released by a finalizer on the
run stream's scope, and that scope only closes three ways: a terminal event, a
client `Interrupt` frame, or the RPC server being told the client disconnected.
The third was never wired — `ServerProtocolLive` built a `disconnects` mailbox
and nothing ever offered to it. So a renderer that dies without unmounting (a
window reload, an electron-vite HMR full reload, a renderer crash) sent no
interrupt and raised no disconnect. The main process, and the reservation map
inside it, outlive the renderer — which is why a reload never cleared it and a
quit always did.

Fixed at both ends:

- **The renderer's death is now reported.** `ServerProtocolLive` watches each
  `WebContents` for `destroyed`, `render-process-gone`, and cross-document main
  frame navigation (reload keeps the same `WebContents`, so nothing else marks
  the old page's requests dead), offering the client id to `disconnects`. The
  server then interrupts that client's in-flight handlers and their finalizers
  run — this releases far more than reservations.
- **A stranded reservation is reclaimed rather than trusted.** A refusal now has
  to be backed by a live run: `fibers` is written under the same chat lock
  immediately after reserving, so "reserved, but no live fiber" is proof the
  reservation outlived its run, not a race. The belt to the first fix's braces —
  a reservation can only be as reliable as the scope that frees it, and this
  path no longer depends on one.

A genuine double-send on a running chat is still refused; that test passes
unchanged, and a new one covers the stranded case.
