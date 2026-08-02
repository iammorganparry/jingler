import { useState } from "react"
import type { PrFileChange } from "@jingler/core"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { ReviewFileSection } from "./review-file-section.js"

/**
 * `ReviewFileSection` header — the broom **Deslop** icon button and the compact
 * **Viewed** checkbox. Rendered on the collapsed-viewed path so the frame is
 * self-contained (the diff body itself is unchanged by this work).
 */
const meta: Meta = { title: "Composites/Review File Section" }
export default meta
type Story = StoryObj

const file: PrFileChange = {
  path: "packages/ui/src/composites/plan-editor.tsx",
  additions: 41,
  deletions: 18,
  commentCount: 0,
  viewed: true
}

function Harness({ compact }: { compact?: boolean }) {
  const [log, setLog] = useState<string | null>(null)
  return (
    <div className="w-[820px] bg-panel">
      <ReviewFileSection
        file={file}
        diff=""
        estimatedHeight={200}
        active
        connected
        routeTargetSession={null}
        local={false}
        compactActions={compact ?? false}
        collapseViewed
        findings={[]}
        review={null}
        onAddDraft={() => {}}
        onToggleViewed={(path, viewed) => setLog(`viewed ${path} = ${viewed}`)}
        onDeslopFile={(path) => setLog(`deslop ${path}`)}
      />
      {log && (
        <div className="border-t border-hairline px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
          {log}
        </div>
      )}
    </div>
  )
}

/** Full-width header: broom Deslop + "Viewed" label. */
export const Default: Story = { render: () => <Harness /> }

/** Narrow header: actions collapse to icon-only (broom + tick). */
export const Compact: Story = { render: () => <Harness compact /> }
