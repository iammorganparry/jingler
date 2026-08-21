# Expo iOS Preview

Jingler's official Expo plugin mounts the current worktree's iOS Simulator in an **Expo** session tab and exposes the same preview to native agent tools.

## Prerequisites

- macOS with Xcode and its command-line tools selected.
- At least one iOS Simulator runtime installed in Xcode.
- Project dependencies installed so `node_modules/.bin/expo` exists in the worktree.
- Expo Go, or the project's development client, installed in the selected Simulator.

Expo's current setup guidance is at [Start developing](https://docs.expo.dev/get-started/start-developing/) and [iOS Simulator](https://docs.expo.dev/workflow/ios-simulator/).

## Using the preview

1. Open a Jingler session whose worktree contains the Expo project.
2. Open the **Expo** tab and select **Start iOS Preview**.
3. Use the tab toolbar to reload, reveal Simulator, or stop the preview.

The plugin runs the worktree-local Expo CLI with `start --ios`, mirrors the most recently booted Simulator, retains at most 100 redacted log lines, and allows only one Jingler session to own its process at a time. Stopping the preview or deactivating the plugin terminates the whole detached Expo process group.

## Agent tools

The `expo.ios-preview` native toolset provides:

- lifecycle: status, open, reload, stop, and reveal Simulator;
- semantic inspection: a bounded XCTest accessibility hierarchy;
- actions: wait, tap, type or replace text, swipe, and press Home.

Selectors accept exactly one accessibility identifier, label, or visible text value. Add stable React Native accessibility labels/test IDs when an element is otherwise ambiguous. Automation uses Apple's public [XCTest UI testing](https://developer.apple.com/documentation/xctest/user-interface-tests) APIs and is serialized so concurrent calls cannot race one Simulator.

## Limitations

- iOS Simulator only; Android and physical devices are not supported yet.
- The plugin starts Metro but does not create or build a missing native development client.
- The first automation call compiles the bundled XCTest runner and can take longer than later actions.
- Raw coordinate tapping is intentionally unsupported because it is brittle across device sizes and layouts.
- Simulator hardware limitations, including camera and motion behavior, still apply.
