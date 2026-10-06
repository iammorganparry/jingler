# Chat text selection
- [x] Trace selection and link handling in chat output.
- [ ] Finish the shared selection fix: text is explicitly selectable; links no longer drag or navigate on selected clicks. Left-to-right file-path selection still fails the E2E regression; right-to-left passes.
- [ ] Complete verification and final review after fixing the remaining regression.

## Checks
- 24 focused unit tests passed.
- 9 asset/navigation E2E tests passed before the explicit transcript selection change.
- Lint and desktop typecheck passed on latest source.
- Full typecheck blocked by server build requiring BETTER_AUTH_SECRET.
- Full unit suite: 483 files passed; pi-subagents-rpc-patch.test.ts failed because test/model is unavailable.
- Review finding about middle-click file navigation fixed with auxiliary navigation suppression.
- Operator confirms ordinary text cannot be selected immediately after launch. Fresh-launch baseline prose selection succeeds in E2E; shared MessageTurn now explicitly uses select-text.
