# Native text context menu
- [x] Add Electron's missing native context menu for selected text, links, and editable fields.
- [x] Add real-app right-click coverage and preserve renderer-owned menus.
- [x] Run focused unit/E2E tests, lint/typecheck, and review.

## Clarified requirement and implementation
The original issue is the absence of a right-click context menu. Electron supplies no default context menu. `registerTextContextMenu` now listens on the main window's `webContents` and displays native Copy for selected text, Copy Link Address for links, and Cut/Copy/Paste/Select All in editable fields. Edit flags control enabled actions; the popup receives the originating window and frame. Empty backgrounds produce no menu. Existing renderer context menus continue to own their right-click events.

## Verified results
- New context-menu unit tests: **7 passed**. They cover menu contents, edit flags, selected links, clipboard action, window/frame association, handled events, empty backgrounds, and null frames.
- Existing Markdown/asset unit tests: **24 passed**; combined focused run **31 passed**.
- Built-app `chat-selection.spec.ts`: **2 passed**, including the prior forward/backward drag/copy regression and the new native context-menu regression.
- Native-menu E2E uses real pointer selection/right-click events and captures the actual Electron Menu at the OS popup step. It confirms enabled Copy without changing the selection, invokes Copy Link Address and checks the real clipboard, confirms editable-text roles, and verifies the renderer sidebar menu appears without a native popup.
- `pnpm lint`: **0 errors**, 87 existing warnings.
- `pnpm --filter @jingler/desktop typecheck`: **passed**.
- `git diff --check`: **passed**.
- Independent native-context-menu review: **no findings; OK**.
- Changeset now describes native right-click menus alongside the earlier selection improvements.

## Documentation/version
- Installed Electron: **43.1.0**; installed typings match the used APIs.
- [Official context-menu guide](https://electronjs.org/docs/latest/tutorial/context-menu): main-process event, native roles, popup window/frame.
- [MenuItem API](https://electronjs.org/docs/latest/api/menu-item): native roles and invoking the custom link-address action in the E2E capture.
- [Menu API](https://electronjs.org/docs/latest/api/menu): native template/popup behavior.

## Check scope
PR preparation reran checks after rebasing onto current main. `pnpm test`: 486 test files passed; 1 file failed (4684 tests passed, 1 failed, 5 skipped). The pre-existing pi-subagents-rpc-patch.test.ts fixture still requests unavailable `test/model`. `pnpm typecheck` remains blocked by the server production build requiring `BETTER_AUTH_SECRET`; desktop typecheck passes. The final rebuilt selection/context-menu E2E passes both tests. These full-repository blockers are documented in the PR, not claimed fixed. Previous selection improvements remain in place and their regression still passes.
