import type { Meta, StoryObj } from "@storybook/react-vite"
import type { PrFileChange } from "@jingler/core"
import { useMemo, useState } from "react"
import { ReviewFileRail } from "./review-file-rail.js"
import { ReviewFileRow } from "./review-file-row.js"
import { useCodeReviewView } from "./use-code-review-view.js"

/**
 * Playground for the Code Review left rail — the search bar, the type/feedback
 * filters, and the file rows with their (now shadcn-sized) viewed checkboxes.
 *
 * The rail is driven by the real `useCodeReviewView` machine, so filtering and
 * search behave exactly as they do in the app; only the file data and the
 * viewed/selection state are mocked locally.
 */
const meta: Meta = { title: "Composites/Code Review Rail" }
export default meta
type Story = StoryObj

const file = (
  path: string,
  additions: number,
  deletions: number,
  viewed = false
): PrFileChange => ({ path, additions, deletions, commentCount: 0, viewed })

const SEED: readonly PrFileChange[] = [
  file("README.md", 7, 0, true),
  file("apps/desktop/e2e/fake-auth.ts", 599, 36, true),
  file("apps/desktop/e2e/fixtures.ts", 13, 2, true),
  file("apps/desktop/e2e/memory-map.spec.ts", 91, 0),
  file("packages/cli-adapters/src/memory-electron.ts", 33, 0),
  file("packages/cli-adapters/src/shared-memory.ts", 165, 0),
  file("packages/contracts/src/rpc.ts", 335, 4),
  file("packages/cli-adapters/src/runtime.ts", 2, 0),
  file("packages/cli-adapters/src/zip.test.ts", 21, 0),
  file("packages/ui/src/app/App.tsx", 90, 0),
  file("packages/ui/src/composites/memory-layout.tsx", 65, 0),
  file("packages/ui/src/composites/memory-machine.ts", 224, 0)
]

/** Which files carry feedback, so the "With feedback" filter has something to do. */
const FEEDBACK = new Map<string, number>([
  ["README.md", 1],
  ["apps/desktop/e2e/fake-auth.ts", 3],
  ["packages/contracts/src/rpc.ts", 6]
])

function RailHarness() {
  const controls = useCodeReviewView()
  const [files, setFiles] = useState<readonly PrFileChange[]>(SEED)
  const [activePath, setActivePath] = useState<string | null>("README.md")

  const filtered = useMemo(() => {
    const q = controls.query.trim().toLowerCase()
    return files.filter((f) => {
      if (q && !f.path.toLowerCase().includes(q)) return false
      if (controls.feedbackOnly && !FEEDBACK.has(f.path)) return false
      return true
    })
  }, [files, controls.query, controls.feedbackOnly])

  const setViewed = (path: string, viewed: boolean) =>
    setFiles((prev) => prev.map((f) => (f.path === path ? { ...f, viewed } : f)))

  return (
    <div className="flex h-[720px] w-[320px] flex-col overflow-hidden rounded-lg border border-line bg-panel">
      <ReviewFileRail
        files={filtered}
        totalFiles={files.length}
        activePath={activePath}
        feedback={FEEDBACK}
        feedbackAny
        added={files.reduce((n, f) => n + f.additions, 0)}
        removed={files.reduce((n, f) => n + f.deletions, 0)}
        viewed={files.filter((f) => f.viewed).length}
        controls={controls}
        onSelectFile={setActivePath}
        onToggleViewed={setViewed}
      />
    </div>
  )
}

/** The full rail, wired to the real filter machine and local viewed state. */
export const Rail: Story = { render: () => <RailHarness /> }

/** Just the rows, to isolate the checkbox / feedback-marker sizing. */
export const Rows: Story = {
  render: () => (
    <div className="flex w-[300px] flex-col gap-px rounded-lg border border-line bg-panel p-2">
      <ReviewFileRow
        file={file("packages/contracts/src/rpc.ts", 335, 4)}
        active
        feedback={6}
        onSelect={() => {}}
        onToggleViewed={() => {}}
      />
      <ReviewFileRow
        file={file("README.md", 7, 0, true)}
        active={false}
        feedback={1}
        onSelect={() => {}}
        onToggleViewed={() => {}}
      />
      <ReviewFileRow
        file={file("packages/ui/src/app/App.tsx", 90, 0)}
        active={false}
        onSelect={() => {}}
        onToggleViewed={() => {}}
      />
    </div>
  )
}
