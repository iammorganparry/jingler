/**
 * Floating "Ask ⌘L" pill shown when the chat lane is collapsed.
 * Clicking it or pressing ⌘L restores the previous docked width.
 */
import { Button } from "./button.js"
import { KbdChip } from "./kbd.js"

export interface AskPillProps {
  readonly onClick: () => void
  readonly className?: string
}

export function AskPill({ onClick, className }: AskPillProps) {
  return (
    <div className={className}>
      <Button
        variant="secondary"
        size="md"
        onClick={onClick}
        className="gap-2"
        aria-label="Show chat lane"
      >
        Ask <KbdChip shortcut="mod+l" />
      </Button>
    </div>
  )
}
