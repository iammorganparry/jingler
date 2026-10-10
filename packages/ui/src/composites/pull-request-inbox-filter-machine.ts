import { assign, setup } from "xstate"

export type PullRequestInboxFilter = "all" | "created" | "assigned" | "review-requested"
export interface PullRequestInboxFacets {
  repository: string
  author: string
  label: string
  draft: "all" | "draft" | "ready"
}
interface InboxFilters extends PullRequestInboxFacets {
  filter: PullRequestInboxFilter
  query: string
}
export const initialInboxFilters: InboxFilters = {
  filter: "all", query: "", repository: "", author: "", label: "", draft: "all",
}
export const pullRequestInboxFilterMachine = setup({
  types: {
    context: {} as InboxFilters,
    events: {} as { type: "CHANGE"; fields: Partial<InboxFilters> } | { type: "CLEAR" },
  },
}).createMachine({
  id: "pull-request-inbox-filters",
  context: initialInboxFilters,
  on: {
    CHANGE: { actions: assign(({ event }) => event.fields) },
    CLEAR: { actions: assign(initialInboxFilters) },
  },
})
