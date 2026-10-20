import { StatusRow } from "./status-row.js"

/**
 * Import-review row for an OAuth server: it imports successfully but needs a
 * browser sign-in afterwards. `host` is the remote server's URL origin shown
 * for context; sign-in itself happens later in Settings.
 */
export function NeedsSignInRow({ host }: { host: string }) {
  return (
    <StatusRow>
      Needs sign-in · <span className="font-mono text-dim">{host}</span> · Sign in after import
    </StatusRow>
  )
}
