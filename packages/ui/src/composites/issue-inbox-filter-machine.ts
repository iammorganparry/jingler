import { assign, setup } from "xstate"

export type IssueInboxFilter = "all" | "created" | "assigned"
export interface IssueInboxFacets {
  repository: string
  author: string
  assignee: string
  label: string
}
interface IssueInboxFilters extends IssueInboxFacets {
  filter: IssueInboxFilter
  query: string
}
export const initialIssueInboxFilters: IssueInboxFilters = {
  filter: "all", query: "", repository: "", author: "", assignee: "", label: "",
}
export const issueInboxFilterMachine = setup({
  types: {
    context: {} as IssueInboxFilters,
    events: {} as { type: "CHANGE"; fields: Partial<IssueInboxFilters> } | { type: "CLEAR" },
  },
}).createMachine({
  id: "issue-inbox-filters",
  context: initialIssueInboxFilters,
  on: {
    CHANGE: { actions: assign(({ event }) => event.fields) },
    CLEAR: { actions: assign(initialIssueInboxFilters) },
  },
})
