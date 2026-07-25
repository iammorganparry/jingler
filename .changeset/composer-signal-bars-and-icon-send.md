---
"@starbase/ui": patch
---

Retune the composer toolbar's trailing end: the branch now rides beside send, and send/stop are icon buttons.

The branch used to lead the row, next to the model chip. But "where is this about to land?" is a question you ask at the moment you send, not while picking a model — so it now sits immediately before the send button, still truncating first when the row is squeezed since it is the only control there that can lose characters and stay useful.

Send and stop dropped their text for an arrow and a stop square. Icon-only means `aria-label` is now the sole accessible name — the labels are preserved (`Send ↵`, `Queue ↵`, `Stop`) so existing selectors and screen readers still find them.

Reasoning strength swapped its brain glyph for cell-service signal bars, filled one rung per step of the harness's own ladder. A brain said "thinking" and nothing about how much; bars carry the magnitude at a glance. The scale is the provider's, not a fixed one — Claude runs low…max and Codex minimal…xhigh, so "high" is 3 of 5 bars on one and 4 of 5 on the other. Neither `default` nor `off` fills a bar (neither is a strength); `off` is told apart by a slash through the ramp.
