import type { Meta, StoryObj } from "@storybook/react-vite"
import type { ProviderModels } from "@jingler/core"
import { BOUNDARY_WIDTHS, LookFor, WidthLadder } from "../story-support.js"
import { Composer } from "./composer.js"

const meta: Meta = { title: "Responsive/Composer", parameters: { layout: "fullscreen" } }
export default meta
type Story = StoryObj

/**
 * A realistically long model id. This is the string that broke the row: as a
 * flex item with no `min-w-0` its floor was its min-content width, so the chip
 * refused to shrink and pushed everything after it past the composer's border.
 */
const CATALOG: ReadonlyArray<ProviderModels> = [
  {
    cli: "claude",
    label: "Claude Code",
    models: [
      { id: "claude-sonnet-4-5-20250929", label: "claude-sonnet-4-5-20250929" },
      { id: "claude-opus-4-1-20250805", label: "claude-opus-4-1-20250805" }
    ]
  },
  { cli: "codex", label: "Codex CLI", models: [{ id: "gpt-5-codex", label: "gpt-5-codex" }] }
]

const loaded = {
  cli: "claude" as const,
  model: "claude-sonnet-4-5-20250929",
  catalog: CATALOG,
  onSetHarness: () => {},
  mode: "accept-edits" as const,
  onSetMode: () => {},
  allowPlan: true,
  branch: "chore/wandering-watt",
  skills: [{ name: "/review", description: "Review current changes", source: "skill" as const }],
  onSend: () => {}
}

/**
 * The toolbar at four widths, fully loaded: tools menu, branch, model, mode,
 * thinking and Send.
 *
 * Eight controls in a row with no `flex-wrap` and — this is the actual bug —
 * not one `min-w-0` anywhere in the file. Two of them carry variable-length text
 * and `Button` is `whitespace-nowrap`, so the row's floor sat well past the
 * composer's own rounded border.
 */
export const Ladder: Story = {
  render: () => (
    <div className="min-h-screen bg-canvas">
      <LookFor>
        <strong className="text-text-bright">Look for:</strong> the branch and model truncating with
        an ellipsis rather than growing, compact gaps between controls, and Send staying full-size.
        The <code>+</code> menu should contain images, skills, and MCP status at every width.
      </LookFor>
      <WidthLadder height={200} render={() => <Composer {...loaded} />} />
    </div>
  )
}

/** The same row at the exact tier boundaries — one change per pair. */
export const Boundaries: Story = {
  render: () => (
    <div className="min-h-screen bg-canvas">
      <LookFor>
        <strong className="text-text-bright">Look for:</strong> 780/779 is the only pair that
        should differ — the branch and model caps shrink. Below that the row only wraps, which is
        CSS rather than a tier decision.
      </LookFor>
      <WidthLadder widths={BOUNDARY_WIDTHS} height={210} render={() => <Composer {...loaded} />} />
    </div>
  )
}

/**
 * Mid-turn: the Stop button replaces Send and a queue hint sits in the
 * placeholder. Stop is the widest of the three states.
 */
export const Busy: Story = {
  render: () => (
    <div className="min-h-screen bg-canvas">
      <LookFor>
        <strong className="text-text-bright">Look for:</strong> Stop reachable without scrolling at
        380px — it is the control you want most while something is running.
      </LookFor>
      <WidthLadder height={200} render={() => <Composer {...loaded} busy onStop={() => {}} />} />
    </div>
  )
}

/**
 * Awaiting approval. The pill reads "paused for approval" when there's room and
 * just "paused" when there isn't — five words is a lot of row to spend on a
 * state the yellow dot already announces.
 */
export const Paused: Story = {
  render: () => (
    <div className="min-h-screen bg-canvas">
      <LookFor>
        <strong className="text-text-bright">Look for:</strong> the pill shortening to{" "}
        <code>paused</code> below 780, and the row never wrapping the pill onto a line of its own.
      </LookFor>
      <WidthLadder height={200} render={() => <Composer {...loaded} paused />} />
    </div>
  )
}
