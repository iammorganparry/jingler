import type { Meta, StoryObj } from "@storybook/react-vite"
import { FileChip } from "./file-chip.js"

/**
 * `FileChip` — the thin, inline file link with Material file identity and diff
 * evidence. Hugs its content (left-aligned), stays visible after commit, and is
 * clickable when given `onOpen`.
 */
const meta: Meta = { title: "Atoms/File Chip" }
export default meta
type Story = StoryObj

export const Variants: Story = {
  render: () => (
    <div className="flex max-w-[520px] flex-wrap items-start gap-2 bg-panel p-4">
      <FileChip path="packages/core/src/plan-view.ts" added={206} removed={0} />
      <FileChip path="packages/ui/src/composites/plan-editor.tsx" added={41} removed={18} />
      <FileChip path="apps/desktop/src/renderer/conversation-pane.tsx" added={3} removed={0} />
      <FileChip path="README.md" />
      <FileChip
        path="packages/ui/src/composites/plan-doc/plan-doc-editor.tsx"
        added={0}
        removed={812}
      />
    </div>
  )
}

export const Clickable: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-2 bg-panel p-4">
      <FileChip
        path="packages/ui/src/components/file-chip.tsx"
        added={12}
        removed={9}
        onOpen={(p) => window.alert(`open ${p}`)}
      />
      <span className="text-[11px] text-dim">Click the chip — it opens via onOpen.</span>
    </div>
  )
}

export const InProse: Story = {
  render: () => (
    <p className="max-w-[560px] bg-panel p-4 text-[12.5px] leading-[2] text-text-body">
      The rework touched{" "}
      <FileChip path="packages/core/src/plan-view.ts" added={206} removed={0} /> and{" "}
      <FileChip path="packages/ui/src/composites/plan-editor.tsx" added={41} removed={18} />, so the
      chips flow inline with the sentence.
    </p>
  )
}
