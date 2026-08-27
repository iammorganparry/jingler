---
description: Use when adding or changing user-visible Electron behavior in Jingler; covers main/preload/renderer flow, visible-browser QA, accessibility, and the required Electron E2E test.
---

# Electron E2E

1. Trace the feature from main process through preload and renderer; reuse the existing IPC or plugin path.
2. Keep privileged work in main/plugin host and expose the smallest typed preload contract.
3. Add one Electron E2E test that exercises the visible behavior, not implementation existence.
4. Run the focused E2E test and inspect the visible Jingler preview when the feature has a browser surface.
5. Verify keyboard/accessibility basics and report the exact test command and observed result.
