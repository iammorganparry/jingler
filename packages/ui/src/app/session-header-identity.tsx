import type { ReactNode } from "react"
import { GitBranch } from "lucide-react"
import { Badge } from "../components/badge.js"
import { HeaderLinkChips, type HeaderLinkChip } from "./header-view-buttons.js"

/** Left of the session header (Paper 04b): title, filled branch chip, outlined PR / issue chips. */
export function SessionHeaderIdentity({
  title,
  branch,
  chips,
  children
}: {
  readonly title: string
  readonly branch?: string
  readonly chips: ReadonlyArray<HeaderLinkChip>
  /** Extra chips (e.g. the multi-PR menu) after the link chips. */
  readonly children?: ReactNode
}) {
  return (
    <div data-testid="session-header-identity" className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 max-w-[260px] truncate text-[13px] font-semibold text-text-bright">{title}</span>
      {branch ? (
        <span data-testid="header-branch" className="flex min-w-0">
          {/* xs = 24px, the PR chip's height. Badge puts children in an inline-block, so the
              icon and label need their own flex row or the label wraps under the icon. */}
          <Badge size="xs" title={branch} className="min-w-0 max-w-[220px] rounded-md border-transparent bg-sunken text-muted-foreground">
            <span className="flex min-w-0 items-center gap-1.5">
              <GitBranch size={14} aria-hidden className="flex-none" />
              <span className="truncate">{branch}</span>
            </span>
          </Badge>
        </span>
      ) : null}
      <HeaderLinkChips chips={chips} />
      {children}
    </div>
  )
}
