---
"@starbase/ui": minor
---

Collapsed the session pane's tab chrome into one row of pills.

A pane used to draw three ruled rows before a word of transcript: the session tabs (bordered full-height cells, a hairline between every one, a top accent on the active one), the chat strip (same again), and — the moment the agent spawned a `Task` — the sub-agent rail (same again, bottom accent). Four horizontal rules and around twenty vertical ones, all at full contrast, framing the one thing you opened the pane to read. Each row was defensible alone; the pile was not. And the third arrived *mid-turn*, so the pane gained a ruled row exactly when you were reading fastest.

Two structural changes, not just a restyle:

**There is no Conversation tab.** The session-name chip is it. The chip was already a permanent, unclickable label sitting immediately beside a tab that meant "show me this session" — two controls for one idea, one of which you couldn't click. Merged, it buys back the chip's width and drops the tab count from five to four. `TabKey` still carries `"conversation"`, because every machine, contract and test names the view that way; only its rendering moved.

**The chat pills share the tab row**, behind a divider — `TabBar`'s new `chatSlot`. `ChatTabBar` is now a fragment rather than a strip, so it inherits the row's gap, alignment and *single* horizontal scroll: chat pills and view tabs scroll together rather than as two half-rows. Chat state stays in the desktop renderer (RPCs plus live per-chat activity) and reaches the bar through a `renderChatTabs` render prop, so `@starbase/ui` never learns about the RPC client.

Net effect: a pane mid-turn is two rows where it used to be three, and one horizontal rule where it used to be four.

The row degrades in four tiers rather than clipping, and nothing is ever hidden behind a menu — a chat you can't see is a chat you forget is running:

- the session title truncates at 210 → 150 → 92px, and at `tiny` becomes a status dot with the name on hover;
- only the *selected* view tab shows a label, and only from `mid` up — the row now competes with chat titles, and a chat title is the thing you actually read to tell two conversations apart;
- the diff counts (`+681 −0`, up to seven tabular glyphs) collapse to a dot below `mid`;
- inactive chat pills drop to dots at `tiny`; the active one always keeps its name;
- sub-agent task descriptions go below `wide`, where they were already the pill's hover title.

Every glyph keeps its `aria-label` and tooltip, so a by-name lookup — a screen reader, `getByRole("button", { name })`, the e2e suite — finds the same control at every width.
