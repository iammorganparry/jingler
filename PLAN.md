# Prevent background sessions from stealing composer focus

## Context

Every streamed agent update in an open Jingler session shifts keyboard focus into that session's composer, even while the operator is typing in another application or window. The intended outcome is that passive transcript updates never activate Jingler or move keyboard focus. An intentional desktop-notification click should still open the named session and focus its composer.

## Approach

- Trace the streamed conversation-state update into the mounted composer and identify the shared imperative focus call/effect.
- Guard that shared focus decision with the renderer's native focus state (`document.hasFocus()` or the existing equivalent), so a passive rerender cannot focus an element while Jingler is inactive.
- Preserve focus behavior while Jingler is already active, including explicit session selection and desktop-notification activation. Do not change transcript streaming or notification delivery.

## Files to modify

- `apps/desktop/src/renderer/App.tsx` and `apps/desktop/src/renderer/conversation-machine.ts` — trace only; change the one that issues the focus request, if either does.
- `packages/ui/src/composites/composer.tsx` — preferred fix location if it owns the shared imperative focus call.
- A focused `*.test.tsx` beside the changed renderer/UI file — add the regression using the repository's jsdom + Testing Library pattern.

> [!NOTE]
> `apps/desktop/src/main/notifications.ts` already activates the window only inside the OS notification `click` callback. The confirmed trigger is streamed output without a click, so the plan does not change main-process notification behavior.

## Reuse

- `apps/desktop/src/main/notifications.ts` keeps `BrowserWindow.show()` and `BrowserWindow.focus()` inside the explicit OS notification `click` callback; preserve that behavior.
- Use the browser-native `document.hasFocus()` check or an existing equivalent. Do not add state, IPC, or a new abstraction.
- Follow the jsdom + Testing Library conventions in `packages/ui/src/app/session-split.test.tsx` and the test discovery configured by `packages/ui/vitest.config.ts` / `apps/desktop/vitest.config.ts`.

## Steps

- [ ] Trace a streamed `conversation-machine` update through `App` to the composer and inventory the shared programmatic focus callers.
- [ ] Add one inactivity guard at the shared focus decision point; leave explicit notification-click and active-window focus behavior unchanged.
- [ ] Add one regression test that rerenders with streamed activity while `document.hasFocus()` is false and proves the composer is not focused; also prove the active-window path still focuses.
- [ ] Run the focused Vitest file, desktop/UI type-checks for touched packages, and the relevant Electron manual check.

## Verification

- Automated: run the new focused Vitest file, `pnpm --filter @jingler/ui typecheck` if UI changes, and `pnpm --filter @jingler/desktop typecheck` if renderer changes.
- Manual: type continuously in another app/window while an open Jingler session streams several updates; verify Jingler stays inactive and every keystroke remains in the original app.
- Manual: click a Jingler desktop notification; verify Jingler opens the named session and focuses its composer.
- Manual: with Jingler already active, explicitly select a session/composer and verify normal focus behavior still works.
