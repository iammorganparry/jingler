import type { SidebarReleaseNotes } from "@jingler/ui"
import { useState } from "react"
import changelog from "../../CHANGELOG.md?raw"
import { compareVersions, notesBetween, parseChangelog } from "./release-notes.js"

/** The version the app last ran as; the card shows when this falls behind. */
export const LAST_RUN_VERSION_KEY = "jingler.last-run-version"

const read = (): string | null => {
  try {
    return localStorage.getItem(LAST_RUN_VERSION_KEY)
  } catch {
    return null
  }
}

const remember = (version: string): void => {
  try {
    localStorage.setItem(LAST_RUN_VERSION_KEY, version)
  } catch {
    // Storage unavailable: the card simply shows again next launch.
  }
}

/**
 * "Updated to vX" after the app relaunches on a newer version.
 *
 * The first launch of an install has nothing to compare against, so it only
 * records the version. After that, a launch on a newer version than last seen
 * shows every CHANGELOG entry in between until the operator dismisses it.
 */
export function useReleaseNotes(
  currentVersion: string,
  source: string = changelog
): SidebarReleaseNotes | undefined {
  const [previous, setPrevious] = useState(() => {
    const stored = read()
    if (stored === null) remember(currentVersion)
    return stored ?? currentVersion
  })

  if (compareVersions(currentVersion, previous) <= 0) {
    if (previous !== currentVersion) remember(currentVersion)
    return undefined
  }

  return {
    version: currentVersion,
    notes: notesBetween(parseChangelog(source), previous, currentVersion),
    onDismiss: () => {
      remember(currentVersion)
      setPrevious(currentVersion)
    }
  }
}
