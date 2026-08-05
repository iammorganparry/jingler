import type { Meta, StoryObj } from "@storybook/react-vite"
import type { PrFileChange } from "@jingler/core"
import { useMemo, useState } from "react"
import { PierreProvider } from "../diff/pierre-provider.js"
import { ReviewFileRail } from "./review-file-rail.js"
import { useCodeReviewView } from "./use-code-review-view.js"

/**
 * Playground for the Code Review left rail — the search bar, the type/feedback
 * filters, and the hierarchical Pierre tree with Git status decoration.
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
  const [activePath, setActivePath] = useState<string | null>("README.md")

  const filtered = useMemo(() => {
    const q = controls.query.trim().toLowerCase()
    return SEED.filter((f) => {
      if (q && !f.path.toLowerCase().includes(q)) return false
      if (controls.feedbackOnly && !FEEDBACK.has(f.path)) return false
      return true
    })
  }, [controls.query, controls.feedbackOnly])

  return (
    <PierreProvider workers={false}>
      <div className="flex h-[720px] w-[320px] flex-col overflow-hidden rounded-lg border border-line bg-panel">
        <ReviewFileRail
          files={filtered}
          totalFiles={SEED.length}
          activePath={activePath}
          feedback={FEEDBACK}
          feedbackAny
          statusByPath={new Map(SEED.map((entry) => [entry.path, "modified" as const]))}
          added={SEED.reduce((n, f) => n + f.additions, 0)}
          removed={SEED.reduce((n, f) => n + f.deletions, 0)}
          viewed={SEED.filter((f) => f.viewed).length}
          controls={controls}
          onSelectFile={setActivePath}
        />
      </div>
    </PierreProvider>
  )
}

/** The full hierarchical rail, wired to the real filter machine. */
export const Rail: Story = { render: () => <RailHarness /> }
