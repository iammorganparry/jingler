# Session tab groups and nested splits

## Goal

Add a collapsible **Views** group for opened Browser, Plan, PR, Changes, Explanation, Terminal, and plugin tabs. Let chats, files, and opened views be dragged into horizontal splits inside each existing outer session pane. Replace the direct New Chat `+` action with a tab launcher: click opens a dropdown; `⌘T` opens a command menu; number keys choose the first nine visible tab types.

## Decisions

- Keep the existing outer session workspace and sidebar grouping unchanged.
- Add a separate per-session inner surface layout; do not overload outer session panes with chat/file/view identities.
- Keep the view rail as a secondary launcher/reopener for available views; remove its separate terminal toggle because Terminal becomes an ordinary view tab.
- Build one `TabLauncherItem[]` model for both launchers. The `+` uses a compact anchored dropdown; `⌘T` uses the existing command-menu visual language. While either menu is open, `1`–`9` select the matching visible item and each row shows its number.
- Launcher order is stable: New Chat, File, Browser, Terminal, then the remaining currently available built-in/plugin views. Unavailable types are absent, not disabled.
- Choosing New Chat creates and focuses a chat. Choosing File opens the existing quick-file picker, then focuses the selected file tab. Choosing an already-open singleton view focuses it instead of duplicating it.
- Clicking a tab selects it in the focused inner pane. Dragging to an edge inserts/moves it; dropping in the middle replaces the target. A surface is rendered at most once per session pane.
- Browser and Plan surfaces retain the chat that opened them. Session-level views (PR, Changes, Explanation, plugin tabs) remain session-owned.
- Persist inner pane membership, focus, and ratios in a separate versioned localStorage key. Validate and prune closed chats/files and unavailable contributed views on restore.
- Keep the existing four-pane cap and width-derived minimum for nested splits.
- Use the repo's existing `motion@^12.42.2` primitives and motion tokens for insert, move, replace, and close transitions. Respect reduced-motion behavior already configured by the app.
- Keep surface components keyed by stable surface identity so layout changes move existing DOM instead of remounting conversations, editors, plugin views, or native browser hosts.
- Keep high-frequency pointer work out of React: divider drags write widths directly to the affected DOM nodes and commit layout state once on release, matching the current auxiliary divider optimization.
- Memoize only measured hot paths. Verify render counts before adding memoization so the optimization does not create stale callback/state bugs.

## Work

- [x] 1. Add and test a small inner surface-layout model plus versioned persistence/pruning.
- [x] 2. Reuse the existing split geometry by making pane identity and drag payload configurable without changing outer-session behavior; animate inserts, moves, replacements, and exits with the existing Motion spring/fast tokens.
- [ ] 3. Add draggable chat/file/view tabs and a collapsible Views group with close-one and close-all actions; use a lightweight drag preview and animate only transform/opacity/layout properties.
- [ ] 4. Add the shared tab-launcher item model, `+` dropdown, and `⌘T` command menu with visible `1`–`9` quick keys; route New Chat and File through their existing create/quick-open flows.
- [ ] 5. Convert Terminal from a window dock to a contribution-backed session view, reusing the persistent terminal actors and xterm cells while removing dock-side/visibility chrome and state.
- [ ] 6. Replace the fixed conversation/auxiliary split in `SessionPane` with the inner surface split, including chat-addressed rendering and independent file documents; preserve mounted subtrees by stable surface key.
- [ ] 7. Update focused commands, browser/plan ownership, native browser bounds, and lifecycle cleanup for nested panes without remounting unchanged surfaces.
- [ ] 8. Add component and desktop e2e coverage for Views grouping, both tab launchers/quick keys, nested splits inside an outer split, terminal lifecycle, close behavior, persistence, ignored OS file drops, and reduced-motion behavior.
- [ ] 9. Add a render-count/drag regression check proving divider pointer moves do not rerender conversation/editor/xterm surfaces, then run targeted unit tests, typecheck/lint, relevant desktop e2e specs, and review the final diff.

## Constraints to preserve

- Conversation actors stay one per `(sessionId, chatId)` and must not be duplicated for the same surface.
- Plan’s conversation mount group must not remount and abort a parked plan run.
- File edits must remain protected from accidental loss when a file tab or split pane closes.
- Plugin failures must remain isolated; unavailable plugin tabs are pruned rather than blanking the pane.
- Native browser previews must survive focus changes, receive bounds updates throughout Motion layout changes, and be destroyed only when their owning view closes.
- Closing the Terminal view hides its xterm cells but does not kill PTYs; closing an individual terminal inside the view keeps the existing explicit kill behavior.
- `⌘T` is handled once by the focused session pane. Remove the conversation-level handler so one keypress cannot both open the launcher and create a chat.
- Pointer-move handlers must not publish React state per frame; only the two visible pane widths may change during a divider drag.
- Motion must not animate width/left directly when a transform/layout animation can do the same work, avoiding layout thrash.
- No duplicate hidden render tree: an opened tab that is not visible stays as metadata, not a mounted off-screen pane.
