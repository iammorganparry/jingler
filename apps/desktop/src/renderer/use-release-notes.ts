import type { SidebarReleaseNotes, WhatsNewEntry } from "@jingler/ui"
import { useState } from "react"
import changelog from "../../CHANGELOG.md?raw"
import { compareVersions, entriesBetween, notesBetween, parseChangelog } from "./release-notes.js"

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

export interface ReleaseNotesState {
  /** The "Updated to vX" card; absent once dismissed or when nothing is new. */
  readonly announcement?: SidebarReleaseNotes
  /** What the account menu's "What's new" dialog lists; always available. */
  readonly whatsNew: readonly WhatsNewEntry[]
}

/**
 * "Updated to vX" after the app relaunches on a newer version, plus the
 * reopenable "What's new" list behind the account menu.
 *
 * The first launch of an install has nothing to compare against, so it only
 * records the version. After that, a launch on a newer version than last seen
 * announces every CHANGELOG entry in between until the operator dismisses it.
 * Dismissal only hides the card: the dialog keeps listing every version the
 * app skipped this launch, and falls back to the current version's notes when
 * none were skipped.
 */
export function useReleaseNotes(
  currentVersion: string,
  source: string = changelog
): ReleaseNotesState {
  const [launchedFrom] = useState(() => {
    const stored = read()
    if (stored === null) remember(currentVersion)
    return stored ?? currentVersion
  })
  const [dismissed, setDismissed] = useState(false)

  const entries = parseChangelog(source)
  const updated = compareVersions(currentVersion, launchedFrom) > 0
  if (!updated && launchedFrom !== currentVersion) remember(currentVersion)

  return {
    announcement:
      updated && !dismissed
        ? {
            version: currentVersion,
            notes: notesBetween(entries, launchedFrom, currentVersion),
            onDismiss: () => {
              remember(currentVersion)
              setDismissed(true)
            }
          }
        : undefined,
    whatsNew: updated
      ? entriesBetween(entries, launchedFrom, currentVersion)
      : entries.filter((entry) => entry.version === currentVersion)
  }
}
