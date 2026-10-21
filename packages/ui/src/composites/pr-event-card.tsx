import { createContext, useContext, useState } from "react"
import { GitMerge, GitPullRequest } from "lucide-react"
import type { PrEventPart } from "@jingler/core"
import { BannerShell } from "../components/banner-shell.js"
import { Button } from "../components/button.js"

/** Host actions for PR transcript cards: reveal the header PR switcher, run the archive flow. */
export const PrEventActionsContext = createContext<{
  readonly openPullRequest?: () => void
  readonly archiveWorkspace?: () => void
} | null>(null)

/** Persisted transcript card: `Opened #N · stacked on #M`, or `PR #N merged` with Archive / Keep open. */
export function PrEventCard({ event, className }: { event: PrEventPart; className?: string }) {
  const actions = useContext(PrEventActionsContext)
  const [kept, setKept] = useState(false)
  if (event.kind === "opened") {
    return (
      <BannerShell
        placement="card"
        className={className}
        icon={<GitPullRequest size={13} />}
        actions={[
          <Button key="open" variant="secondary" size="sm" disabled={!actions?.openPullRequest} onClick={actions?.openPullRequest}>
            View PRs
          </Button>
        ]}
      >
        Opened #{event.number}
        {event.stackedOn !== undefined && ` · stacked on #${event.stackedOn}`}
      </BannerShell>
    )
  }
  return (
    <BannerShell
      placement="card"
      className={className}
      icon={<GitMerge size={13} />}
      actions={
        kept
          ? undefined
          : [
              <Button key="archive" variant="primary" size="sm" disabled={!actions?.archiveWorkspace} onClick={actions?.archiveWorkspace}>
                Archive workspace
              </Button>,
              <Button key="keep" variant="secondary" size="sm" onClick={() => setKept(true)}>
                Keep open
              </Button>
            ]
      }
    >
      PR #{event.number} merged
    </BannerShell>
  )
}
