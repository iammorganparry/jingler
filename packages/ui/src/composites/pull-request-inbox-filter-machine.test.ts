import { describe, expect, it } from "vitest"
import { createActor } from "xstate"
import { initialInboxFilters, pullRequestInboxFilterMachine } from "./pull-request-inbox-filter-machine.js"

describe("pullRequestInboxFilterMachine", () => {
  it("combines independent edits and clears the entire view without sharing state between inboxes", () => {
    const first = createActor(pullRequestInboxFilterMachine).start()
    const second = createActor(pullRequestInboxFilterMachine).start()
    first.send({ type: "CHANGE", fields: { repository: "acme/widget", author: "lee", label: "bug", draft: "draft", filter: "assigned" } })
    first.send({ type: "CHANGE", fields: { query: "token" } })
    expect(first.getSnapshot().context).toMatchObject({ repository: "acme/widget", author: "lee", query: "token", filter: "assigned" })
    expect(second.getSnapshot().context).toEqual(initialInboxFilters)
    first.send({ type: "CLEAR" })
    expect(first.getSnapshot().context).toEqual(initialInboxFilters)
    first.stop()
    second.stop()
  })
})
