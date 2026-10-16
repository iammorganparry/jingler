import type { Meta, StoryObj } from "@storybook/react-vite"
import { testSession } from "../test-support.js"
import type { PrStackLayer } from "./pr-stack-rail.js"
import { SessionHoverCard } from "./session-hover-card.js"

const meta: Meta = { title: "Sidebar/Session Hover Card", parameters: { layout: "centered" } }
export default meta
type Story = StoryObj

const STACK: ReadonlyArray<PrStackLayer> = [
  { number: 480, branch: "stack/model", state: "merged", checks: "pass" },
  { number: 481, branch: "stack/api", state: "open", checks: "pass" },
  { number: 482, branch: "stack/ui", state: "open", checks: "fail" }
]

/** A single-PR session: the one-line PR row, same as before this issue. */
export const SinglePr: Story = {
  render: () => (
    <div className="rounded-lg border border-line bg-surface p-2.5">
      <SessionHoverCard
        session={testSession({
          id: "single",
          title: "Fix PR inbox pagination",
          prNumber: 482,
          diff: { added: 120, removed: 18 }
        })}
        prState={{ state: "open", checks: "pass" }}
      />
    </div>
  )
}

/** Board 04m's stack, rendered in the card: bottom layer first, number + state word per row. */
export const PrStack: Story = {
  render: () => (
    <div className="rounded-lg border border-line bg-surface p-2.5">
      <SessionHoverCard
        session={testSession({
          id: "stacked",
          title: "Add stack model",
          prNumber: 482,
          diff: { added: 312, removed: 44 }
        })}
        stack={STACK}
      />
    </div>
  )
}

/** No PR, no diff: the footer collapses entirely rather than showing an empty strip. */
export const NoPr: Story = {
  render: () => (
    <div className="rounded-lg border border-line bg-surface p-2.5">
      <SessionHoverCard session={testSession({ id: "no-pr", title: "Investigate flaky test" })} />
    </div>
  )
}
