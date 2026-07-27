---
"@jingler/desktop": patch
"@jingler/cli-adapters": patch
---

Fixed: the context meter, the Compact now button and automatic compaction had all silently stopped working.

`ContextManager.bind` collided with `Function.prototype.bind`.

`Effect.Service(..., { accessors: true })` hangs the generated accessors off the class. A class is a function object, so `bind` was already taken and the accessor was never created — every `ContextManager.bind(chatId, sessionId)` resolved to the built-in and returned a *bound copy of the class* rather than an Effect. That copy still inherits the Tag's static `pipe` and `[Symbol.iterator]`, so `.pipe(...)` and `yield*` both kept type-checking and kept executing, and nothing ever threw. The call was simply a no-op, at all three sites: `Context.state`, `Context.compactNow`, and the agent runner.

The consequence was total rather than partial, which is what made it hard to spot as a bug rather than a design. With `owners` never populated, `ownerOf` fell through to the chat id, `SessionStore.get` was handed `c_<id>_1` instead of a session id and failed, and `settingsFor` returned null. Every snapshot then came back with `window: null` — and a null window is a legitimate, well-handled state everywhere downstream, meaning `ContextMeter` renders nothing at all, the Compact now button never exists, and `auto` is false so no session ever compacts on its own. A feature that had degraded exactly the way it was designed to degrade when a harness reports nothing.

The method is now `bindContext`.

It escaped the unit suite because every existing test drives the manager with the same id for both the session and the chat — the legacy one-chat shape, where `ownerOf` falls through to the id it was handed and is right by accident, so the binding is never exercised. The new `chat-scoped context` tests use a distinct chat id: one asserts a bound chat resolves to a real window and trigger point, and a negative control asserts an *unbound* chat reports an unknown window, so the pair proves the binding rather than merely that a window can be computed. The first fails with the old name — `expected null to be 200000`.

Diagnosis is worth recording, because reading the code did not find it: the wiring is correct at every layer and typechecks clean. It took probing the live app — `tokens=42100`, `triggerAt=null` in the renderer, then `settingsNull=true` and `ownerId=c_s_ctx_1` inside the manager, then `bind=undefined` proving the binder's body never ran while the handler around it did.
