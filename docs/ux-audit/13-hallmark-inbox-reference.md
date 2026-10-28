# Inbox reference for the Hallmark pass (operator, 24 Oct)

Operator-supplied reference for our inbox views (a support-threads app). Use it as the target when Hallmark redesigns the inbox.

## What to take from it
- **Three columns:** a thin icon rail (back, prev/next, toggle), the thread list, and a detail pane.
- **List header:** title + count ("Threads · Todo 4") with a `Display` control on the right.
- **List cards:** soft rounded cards, not table rows. Row 1: org avatar + org name (bold) + person. Row 2: muted ID + bold title, truncated. Row 3: small outlined tag chips with icons (Growth, Bug, API). A status glyph sits top-right. The selected card gets a filled background instead of a border.
- **Detail header:** status icon tile, title, a muted meta line ("T-5 · Opened 2h ago via Email"), and view toggles + `…` on the right.
- **Detail body:** the original message in a soft grey bubble, then a "Today" activity timeline of muted one-liners with the value in bold ("You set priority to **Urgent** · Just now").
- **AI summary card** nested in the waiting-state block, with "Show details", thumbs up/down and "Hide Summary".
- **Bottom action bar:** pill buttons with kbd hints (Reply `R`, Note `N`, More, Sidekick `B`).
- **Feel:** light, lots of whitespace, one accent colour used only for status, borders barely visible.

## Mapping to Jingler
- Cards → PR/issue rows in `packages/ui/src/composites/pull-request-inbox.tsx` and `issue-inbox.tsx`.
- Tag chips → existing cataloged pill/badge components; status glyph → existing status components.
- Activity timeline → PR events / checks; summary card → agent review summary.
- Action bar → cataloged button + kbd components.
- Colours via `--sb-*` tokens only, so it must also work in dark themes.
