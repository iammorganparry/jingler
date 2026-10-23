import { HEADER_VIEWS_MAX } from "@jingler/core"
import { SettingsCard, SettingsRow } from "../components/settings-row.js"
import { Toggle } from "../components/toggle.js"
import type { HeaderViewItem } from "../app/header-view-buttons.js"
import { toggleHeaderView } from "../lib/header-views.js"

export interface HeaderViewsSettingsProps {
  /** Every available view, built-ins first. */
  readonly views: ReadonlyArray<HeaderViewItem>
  /** Pinned view ids in header order (the same list the "More views" menu edits). */
  readonly pinned: ReadonlyArray<string>
  readonly onChange: (views: ReadonlyArray<string>) => void
}

/** Settings › Appearance › Header views: pin up to {@link HEADER_VIEWS_MAX} views to the session header. */
export function HeaderViewsSettings({ views, pinned, onChange }: HeaderViewsSettingsProps) {
  const full = pinned.length >= HEADER_VIEWS_MAX
  const row = (view: HeaderViewItem) => {
    const isPinned = pinned.includes(view.id)
    const Icon = view.icon
    return (
      <SettingsRow
        key={view.id}
        label={<span className="flex items-center gap-2"><Icon size={14} className="text-muted-foreground" aria-hidden />{view.label}</span>}
        control={
          <Toggle
            checked={isPinned}
            disabled={!isPinned && full}
            ariaLabel={`Pin ${view.label} to header`}
            onCheckedChange={() => onChange(toggleHeaderView(pinned, view.id))}
          />
        }
      />
    )
  }
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-editor p-6">
      <div className="flex w-full max-w-[720px] flex-col gap-4">
        <div>
          <h2 className="text-[20px] font-semibold text-text-bright">Header views</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Pin up to {HEADER_VIEWS_MAX} views to the session header. The rest stay under More views.
          </p>
        </div>
        <SettingsCard title={`${pinned.length} of ${HEADER_VIEWS_MAX} pinned`}>{views.map(row)}</SettingsCard>
        {full && (
          <p data-testid="header-views-full" className="text-[12px] text-muted-foreground">
            Header is full ({HEADER_VIEWS_MAX} pinned). Unpin a view to pin another.
          </p>
        )}
      </div>
    </div>
  )
}
