# NOTICE

This package is Jingler's fork of `@plannotator/pi-extension` **v0.27.8**,
published by backnotprop (https://github.com/backnotprop/plannotator,
`apps/pi-extension`), licensed by upstream under **MIT OR Apache-2.0**
(SPDX expression asserted in the upstream package.json). This fork retains
that dual license for inherited source. Copyright remains with the upstream
authors.

## What the fork changes

- Baseline: the upstream 0.27.8 source **with Jingler's pnpm patch folded in**
  (host-state/notice event channels, `PLANNOTATOR_EMBEDDED` external-browser
  suppression, `reviewPending` persistence and `/plannotator-resume-review`).
  The patch previously lived at `patches/@plannotator__pi-extension@0.27.8.patch`.
- The code-review and markdown-annotation features were removed (Jingler never
  used them): the `plannotator-review`, `plannotator-annotate` and
  `plannotator-last` commands, `server/serverReview.ts`, `server/serverAnnotate.ts`,
  the upstream code-review bundle, and the generated PR-review / call-flow /
  guide modules they pulled in. Only the plan-review slice remains.
- The upstream review frontend (`apps/hook`) is not shipped. Jingler renders
  plan review natively in `packages/ui/src/screens/plan-review.tsx` and
  receives decisions over the pi event bus (`native-review.ts`).
- `generated/` files keep their upstream "@generated — DO NOT EDIT" headers for
  provenance; in this fork they are ordinary forked source and may be edited.

## Rebasing on upstream

When taking a newer upstream release, diff against the 0.27.8 baseline noted
above, re-apply the host-state contract (see `plannotator-events.ts`
`PLANNOTATOR_HOST_STATE_CHANNEL` / `PLANNOTATOR_HOST_NOTICE_CHANNEL`), and keep
the pi API surface in sync with the pinned `@earendil-works/pi-coding-agent`.
