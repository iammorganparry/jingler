import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import meta, * as storyModule from "./connector-detail.stories.js"
import { ConnectorDetail, type ConnectorDetailProps } from "./connector-detail.js"

/**
 * Every ConnectorDetail story must render, and must render something DIFFERENT.
 *
 * The regression this exists for: the sheet's states used to be documented from
 * `ConnectorCenter`'s stories, where they were unreachable — the sheet only
 * mounts when a card is open, and that is internal state no arg can set. So a
 * `detailLoading: true` story sat in the file rendering pixel-for-pixel the same
 * as `Default`, documenting nothing. A story that cannot show its state is worse
 * than no story: it claims coverage that isn't there.
 */

afterEach(cleanup)

/** A story's shape, loosely: everything here is fed straight back to the component. */
type StoryArgs = Record<string, unknown>

const stories = Object.entries(storyModule).filter(
  (entry): entry is [string, { args?: StoryArgs }] => entry[0] !== "default"
)

const renderStory = (story: { args?: StoryArgs }) => {
  const args = { ...(meta.args as StoryArgs), ...(story.args ?? {}) }
  render(<ConnectorDetail {...(args as unknown as ConnectorDetailProps)} />)
  return screen.getByRole("dialog").textContent ?? ""
}

describe("ConnectorDetail stories", () => {
  it("has stories to check", () => {
    expect(stories.length).toBeGreaterThan(4)
  })

  for (const [name, story] of stories) {
    it(`${name} mounts the sheet`, () => {
      expect(renderStory(story).length).toBeGreaterThan(0)
    })
  }

  it("renders a distinct sheet for every story", () => {
    const rendered = stories.map(([, story]) => {
      const text = renderStory(story)
      cleanup()
      return text
    })
    // Duplicates mean a story's args never reach the DOM — the exact failure
    // that made the old `DetailLoading` story dead.
    expect(new Set(rendered).size).toBe(stories.length)
  })
})
