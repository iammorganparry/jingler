import type { Meta, StoryObj } from "@storybook/react-vite"
import { BOUNDARY_WIDTHS, LookFor, WidthLadder } from "../story-support.js"
import { TabBar, type TabKey } from "./tab-bar.js"
import { ChatTabBar } from "./agent-tab-bar.js"
import { builtinDescriptor } from "./tab-contributions.js"

const meta: Meta = { title: "Responsive/Tab Bar", parameters: { layout: "fullscreen" } }
export default meta
type Story = StoryObj

// Badges now ride on the descriptor rather than on separate `prNumber` /
// `changes` props, so the bar can draw a decoration it has never heard of.
const ALL_TABS = [
  builtinDescriptor("conversation"),
  builtinDescriptor("issue"),
  builtinDescriptor("plan"),
  builtinDescriptor("pr", { kind: "count", text: "#482" }),
  // The diff badge is the widest decoration the row can hold, so the ladder has
  // to include it — this is what main's story carried as a `changes` prop before
  // badges moved onto the descriptors.
  builtinDescriptor("changes", { kind: "diff", added: 313, removed: 23 }),
  builtinDescriptor("review")
]

const noop = () => {}

/** Every control the bar can hold, so the ladder shows the worst case. */
const loaded = {
  tabs: ALL_TABS,
  active: "review" as TabKey,
  onChange: noop,
  // The row now carries the session's name AND the chat pills, so a ladder
  // without them tests a bar that no longer exists anywhere in the app.
  sessionTitle: "feat(signals): account-first signal resolution",
  chatSlot: (
    <ChatTabBar
      chats={[
        { id: "c1", title: "Lets redesign the chat tabs", running: true },
        { id: "c2", title: "Plugin manifest schema" },
        { id: "c3", title: "Theme ramp regression" }
      ]}
      activeChatId="c1"
      onSelectChat={noop}
      onCreateChat={noop}
      onRenameChat={noop}
      onCloseChat={noop}
    />
  ),
  status: { label: "Running", tone: "yellow" as const, detail: "Running pnpm test -- auth" },
  onToggleSplit: noop,
  splitActive: false,
  onToggleBrowser: noop,
  browserActive: false,
  onClosePane: noop,
  onMovePaneLeft: noop,
  onMovePaneRight: noop
}

/**
 * The whole row — session name, four view tabs, a PR badge, a diff stat, three
 * chat pills, a status pill and six pane controls — as the pane narrows.
 *
 * This row's min-content width was roughly 970px BEFORE it absorbed the chat
 * strip, inside a pane the split model will happily make 350px. It had no
 * `min-w-0` and no scroll, so the surplus was clipped by the pane rather than
 * degrading — and because the right-hand cluster was `flex-1`, the CLOSE button
 * was the first thing to disappear.
 */
export const Ladder: Story = {
  render: () => (
    <div className="min-h-screen bg-canvas">
      <LookFor>
        <strong className="text-text-bright">Look for:</strong> the session name shrinking in three
        steps (210 → 150 → 92px) and vanishing at 380, where it becomes a status dot. Only the
        active view tab (Code Review) ever shows text, and it loses that below 560. At 500 the six
        pane controls collapse into a single <code>⋯</code> button — the ✕ stays. At 380 the
        inactive chat pills become dots, the active one keeps its name, and the row scrolls rather
        than spilling past the dashed outline. Nothing should ever cross that outline.
      </LookFor>
      <WidthLadder height={80} render={() => <TabBar {...loaded} />} />
    </div>
  )
}

/**
 * The exact tier boundaries, in pairs.
 *
 * A layout that switches at 780 and 560 has four places it can be wrong by one
 * pixel, and every one of them shows up as a flicker while dragging a divider.
 * Each pair below should look identical apart from the one thing that changed.
 */
export const Boundaries: Story = {
  render: () => (
    <div className="min-h-screen bg-canvas">
      <LookFor>
        <strong className="text-text-bright">Look for:</strong> exactly one difference per pair.
        780/779 = the session name tightens and the sub-agent descriptions would go. 560/559 = the
        active tab's label and the diff counts go, and the pane controls fold into the menu.
        400/399 = the session name and the inactive chat titles go; the active chat keeps its own.
      </LookFor>
      <WidthLadder widths={BOUNDARY_WIDTHS} height={80} render={() => <TabBar {...loaded} />} />
    </div>
  )
}

/**
 * A pane in a split: the conversation tab carries a slot badge, and the title is
 * long.
 *
 * The tab is `flex-none`, so a long session title used to push the rest of the
 * row out entirely. It truncates in three steps and drops out at `tiny`.
 */
export const WithPaneChip: Story = {
  render: () => (
    <div className="min-h-screen bg-canvas">
      <LookFor>
        <strong className="text-text-bright">Look for:</strong> the title truncating rather than
        growing, the slot badge surviving every width, and the chat pills still reachable by
        scrolling at 380.
      </LookFor>
      <WidthLadder
        height={80}
        render={() => (
          <TabBar
            {...loaded}
            pane={{ index: 1, title: "Refactor the auth middleware and token store", focused: true }}
          />
        )}
      />
    </div>
  )
}

/**
 * A single-pane session with nothing to collapse.
 *
 * The overflow menu must NOT appear here — a `⋯` button that opens onto an empty
 * menu is worse than no button.
 */
export const NothingToCollapse: Story = {
  render: () => (
    <div className="min-h-screen bg-canvas">
      <LookFor>
        <strong className="text-text-bright">Look for:</strong> no <code>⋯</code> button at any
        width, because there are no pane actions to put in it.
      </LookFor>
      <WidthLadder
        height={80}
        render={() => (
          <TabBar
            tabs={[builtinDescriptor("conversation"), builtinDescriptor("pr")]}
            active="conversation"
            onChange={noop}
          />
        )}
      />
    </div>
  )
}
