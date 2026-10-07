// @vitest-environment jsdom
import type { GitHubTeamDiscovery, PullRequest, PullRequestListItem } from "@jingler/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { PullRequestInbox } from "../../../../packages/ui/src/composites/pull-request-inbox.js"
import { WidthTierValue } from "../../../../packages/ui/src/hooks/width-tier.js"
import { rpc } from "./rpc-client.js"
import { usePullRequestInbox } from "./use-pull-request-inbox.js"

vi.mock("./rpc-client.js", () => ({ rpc: {
  githubTeams: vi.fn(), githubPrInbox: vi.fn(), githubTeamPrs: vi.fn(),
  githubPrBySlug: vi.fn(), githubTeamPr: vi.fn(),
} }))

const discovery: GitHubTeamDiscovery = { account: { id: "1", login: "octocat" }, teams: [
  { id: "7", organization: "acme", slug: "platform", name: "Platform" },
] }
const pr: PullRequestListItem = {
  repository: "acme/widget", number: 42, title: "Team PR 42", headRefName: "feature", baseRefName: "main",
  author: { login: "teammate", avatarUrl: null }, state: "open", isDraft: false, additions: 0, deletions: 0,
  updatedAt: "2026-01-01", labels: [], comments: 0, assignedToViewer: false, reviewRequestedFromViewer: false,
}
const detail: PullRequest = { ...pr, body: "Before refresh", url: "https://github.com/acme/widget/pull/42",
  createdAt: "2026-01-01", commits: 0, changedFiles: 0, reviewers: [], timeline: [], reviewThreads: [], checks: [],
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", mergeBlockers: [],
}
const Harness = () => {
  const inbox = usePullRequestInbox(false)
  return <WidthTierValue width={1200}><PullRequestInbox
    {...inbox} viewerLogin="octocat" onSelect={inbox.select} onComment={inbox.comment} onActivate={inbox.discover}
    teamControls={{ teams: inbox.teams, teamId: inbox.teamId, queue: inbox.queue,
      onTeam: inbox.selectTeam, onQueue: inbox.selectQueue, onRefresh: inbox.refreshInbox,
      discovering: inbox.discovering, error: inbox.discoveryError }}
  /></WidthTierValue>
}
const mount = () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, retry: false, retryDelay: 0 } } })
  vi.mocked(rpc.githubPrInbox).mockResolvedValue([pr])
  vi.mocked(rpc.githubTeamPrs).mockResolvedValue({ prs: [pr], warnings: [] })
  vi.mocked(rpc.githubPrBySlug).mockResolvedValue(detail)
  vi.mocked(rpc.githubTeamPr).mockResolvedValue(detail)
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
  return client
}
afterEach(() => { cleanup(); vi.resetAllMocks(); localStorage.clear() })

it.each(["personal", "team"])("preserves the %s draft across focus/visibility and refreshes detail inside staleTime", async (scope) => {
  vi.mocked(rpc.githubTeams).mockResolvedValue(discovery)
  const client = mount()
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Pull request scope" }).hasAttribute("disabled")).toBe(false))
  if (scope === "team") fireEvent.change(screen.getByRole("combobox", { name: "Pull request scope" }), { target: { value: "7" } })
  fireEvent.click(await screen.findByRole("button", { name: /Team PR 42/ }))
  const composer = await screen.findByPlaceholderText("Leave a comment…")
  fireEvent.change(composer, { target: { value: "Do not delete this draft" } })
  let complete!: (value: GitHubTeamDiscovery) => void
  vi.mocked(rpc.githubTeams).mockImplementation(() => new Promise((resolve) => { complete = resolve }))
  const read = scope === "team" ? vi.mocked(rpc.githubTeamPr) : vi.mocked(rpc.githubPrBySlug)
  read.mockResolvedValue({ ...detail, body: "Updated externally" })
  fireEvent(window, new Event("focus"))
  expect(screen.getByPlaceholderText("Leave a comment…")).toBe(composer)
  expect((composer as HTMLTextAreaElement).value).toBe("Do not delete this draft")
  fireEvent(document, new Event("visibilitychange"))
  await act(async () => complete(discovery))
  await screen.findByText("Updated externally")
  expect(read).toHaveBeenCalledTimes(2)
  expect(screen.getByPlaceholderText("Leave a comment…")).toBe(composer)
  expect((composer as HTMLTextAreaElement).value).toBe("Do not delete this draft")

  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" }).hasAttribute("disabled")).toBe(false))
  read.mockRejectedValue(new Error("Temporary detail failure"))
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
  await act(async () => complete(discovery))
  await screen.findByText("Temporary detail failure")
  expect(screen.getByPlaceholderText("Leave a comment…")).toBe(composer)
  expect((composer as HTMLTextAreaElement).value).toBe("Do not delete this draft")
  client.clear()
})

it.each(["personal", "team"])("manual %s refresh supersedes an older in-flight detail read without losing the draft", async (scope) => {
  vi.mocked(rpc.githubTeams).mockResolvedValue(discovery)
  const client = mount()
  let finishOld: ((value: PullRequest) => void) | undefined
  let background: Promise<void> | undefined
  try {
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Pull request scope" }).hasAttribute("disabled")).toBe(false))
    if (scope === "team") fireEvent.change(screen.getByRole("combobox", { name: "Pull request scope" }), { target: { value: "7" } })
    fireEvent.click(await screen.findByRole("button", { name: /Team PR 42/ }))
    const composer = await screen.findByPlaceholderText("Leave a comment…")
    fireEvent.change(composer, { target: { value: "Keep the in-flight draft" } })
    const read = scope === "team" ? vi.mocked(rpc.githubTeamPr) : vi.mocked(rpc.githubPrBySlug)
    read.mockImplementationOnce(() => new Promise<PullRequest>((resolve) => { finishOld = resolve }))
    await act(async () => { background = client.refetchQueries({ queryKey: ["github", "pr-inbox", "detail"] }) })
    expect(read).toHaveBeenCalledTimes(2)
    read.mockResolvedValue({ ...detail, body: "Newest manual refresh" })
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
    await screen.findByText("Newest manual refresh")
    expect(read).toHaveBeenCalledTimes(3)
    await act(async () => { finishOld?.({ ...detail, body: "Older in-flight response" }); await background })
    expect(screen.queryByText("Older in-flight response")).toBeNull()
    expect(screen.getByPlaceholderText("Leave a comment…")).toBe(composer)
    expect(composer).toHaveProperty("value", "Keep the in-flight draft")
  } finally {
    finishOld?.(detail)
    await background
    client.clear()
  }
})

it("accepts a personal PR during initial delayed discovery and preserves its draft when CLI identity arrives", async () => {
  let complete!: (value: GitHubTeamDiscovery) => void
  vi.mocked(rpc.githubTeams).mockImplementation(() => new Promise((resolve) => { complete = resolve }))
  const client = mount()
  fireEvent.click(await screen.findByRole("button", { name: /Team PR 42/ }))
  const composer = await screen.findByPlaceholderText("Leave a comment…")
  fireEvent.change(composer, { target: { value: "Personal draft" } })
  await act(async () => complete(discovery))
  expect(screen.getByPlaceholderText("Leave a comment…")).toBe(composer)
  expect((composer as HTMLTextAreaElement).value).toBe("Personal draft")
  expect(rpc.githubPrBySlug).toHaveBeenCalledTimes(1)
  client.clear()
})

it("disables stale team/queue choices after discovery fails but allows switching to Personal", async () => {
  vi.mocked(rpc.githubTeams).mockResolvedValue(discovery)
  const client = mount()
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Pull request scope" }).hasAttribute("disabled")).toBe(false))
  fireEvent.change(screen.getByRole("combobox", { name: "Pull request scope" }), { target: { value: "7" } })
  await screen.findByRole("combobox", { name: "Team pull request queue" })
  vi.mocked(rpc.githubTeams).mockRejectedValue(new Error("Discovery unavailable"))
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
  await screen.findAllByText("Discovery unavailable")
  expect(screen.getByRole("combobox", { name: "Team pull request queue" }).hasAttribute("disabled")).toBe(true)
  expect(screen.getByRole("option", { name: "Platform" }).hasAttribute("disabled")).toBe(true)
  expect(screen.getByRole("option", { name: "Personal" }).hasAttribute("disabled")).toBe(false)
  fireEvent.change(screen.getByRole("combobox", { name: "Pull request scope" }), { target: { value: "" } })
  fireEvent.click(await screen.findByRole("button", { name: /Team PR 42/ }))
  await screen.findByPlaceholderText("Leave a comment…")
  client.clear()
})
