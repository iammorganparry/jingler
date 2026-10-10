// @vitest-environment jsdom
import type { GitHubTeamDiscovery, PullRequest, PullRequestListItem } from "@jingler/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { PullRequestInbox } from "../../../../packages/ui/src/composites/pull-request-inbox.js"
import { WidthTierValue } from "../../../../packages/ui/src/hooks/width-tier.js"
import { rpc } from "./rpc-client.js"
import { usePullRequestInbox } from "./use-pull-request-inbox.js"

vi.mock("./rpc-client.js", () => ({ rpc: {
  githubTeams: vi.fn(), githubPrInbox: vi.fn(), githubTeamPrs: vi.fn(),
  githubPrBySlug: vi.fn(), githubTeamPr: vi.fn(),
  githubCommentBySlug: vi.fn(), githubCloseBySlug: vi.fn(), githubMergeBySlug: vi.fn(),
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
  // Identity now owns an independent key: the unknown read plus one known read.
  await waitFor(() => expect(rpc.githubPrBySlug).toHaveBeenCalledTimes(2))
  expect(screen.getByPlaceholderText("Leave a comment…")).toBe(composer)
  expect(composer).toHaveProperty("value", "Personal draft")
  expect(screen.getByText("Before refresh")).toBeTruthy()
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

it.each([false, true])("isolates personal detail on a known account switch (cached A: %s), including a late A response for the same PR", async (cached) => {
  vi.mocked(rpc.githubTeams).mockResolvedValue(discovery)
  const client = mount()
  let complete!: (value: PullRequest) => void
  try {
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Pull request scope" }).hasAttribute("disabled")).toBe(false))
    if (!cached) vi.mocked(rpc.githubPrBySlug).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    fireEvent.click(await screen.findByRole("button", { name: /Team PR 42/ }))
    if (cached) {
      const composer = await screen.findByPlaceholderText("Leave a comment…")
      fireEvent.change(composer, { target: { value: "Private A draft" } })
      vi.mocked(rpc.githubPrBySlug).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    }
    await waitFor(() => expect(rpc.githubPrBySlug).toHaveBeenCalledTimes(1))
    vi.mocked(rpc.githubTeams).mockResolvedValue({ ...discovery, account: { id: "2", login: "other" } })
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
    await screen.findByText("Select a pull request to review it.")
    expect(screen.queryByPlaceholderText("Leave a comment…")).toBeNull()
    expect(screen.queryByText("Before refresh")).toBeNull()
    vi.mocked(rpc.githubPrBySlug).mockResolvedValue({ ...detail, body: "Only B detail" })
    fireEvent.click(await screen.findByRole("button", { name: /Team PR 42/ }))
    await screen.findByText("Only B detail")
    expect(screen.getByPlaceholderText("Leave a comment…")).toHaveProperty("value", "")
    await act(async () => complete({ ...detail, body: "Late A detail" }))
    expect(screen.queryByText("Late A detail")).toBeNull()
    expect(screen.getByText("Only B detail")).toBeTruthy()
    expect(client.getQueryData(["github", "pr-inbox", "detail", "personal", "1", pr.repository, pr.number])).toMatchObject({ body: "Late A detail" })
    expect(client.getQueryData(["github", "pr-inbox", "detail", "personal", "2", pr.repository, pr.number])).toMatchObject({ body: "Only B detail" })
    expect(rpc.githubTeamPr).not.toHaveBeenCalled()
  } finally { complete?.(detail); client.clear() }
})

it("keeps the unknown/App personal composer after failed discovery and uses only a display placeholder during first identity arrival", async () => {
  vi.mocked(rpc.githubTeams).mockRejectedValue(new Error("CLI unavailable"))
  const client = mount()
  let complete!: (value: PullRequest) => void
  try {
    await screen.findAllByText("CLI unavailable")
    fireEvent.click(await screen.findByRole("button", { name: /Team PR 42/ }))
    const composer = await screen.findByPlaceholderText("Leave a comment…")
    fireEvent.change(composer, { target: { value: "App draft survives" } })
    vi.mocked(rpc.githubTeams).mockResolvedValue(discovery)
    vi.mocked(rpc.githubPrBySlug).mockResolvedValueOnce(detail).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
    await waitFor(() => expect(client.getQueryState(["github", "pr-inbox", "detail", "personal", "1", pr.repository, pr.number])?.fetchStatus).toBe("fetching"))
    expect(client.getQueryData(["github", "pr-inbox", "detail", "personal", "1", pr.repository, pr.number])).toBeUndefined()
    expect(screen.getByPlaceholderText("Leave a comment…")).toBe(composer)
    expect(composer).toHaveProperty("value", "App draft survives")
    expect(screen.getByText("Before refresh")).toBeTruthy()
    await act(async () => complete({ ...detail, body: "Known account detail" }))
    await screen.findByText("Known account detail")
    expect(screen.getByPlaceholderText("Leave a comment…")).toBe(composer)
    expect(composer).toHaveProperty("value", "App draft survives")
    expect(rpc.githubTeamPr).not.toHaveBeenCalled()
  } finally { complete?.(detail); client.clear() }
})

it("preserves the first-identity personal draft even if the independent known-account detail read fails", async () => {
  let discover!: (value: GitHubTeamDiscovery) => void
  vi.mocked(rpc.githubTeams).mockImplementation(() => new Promise((resolve) => { discover = resolve }))
  const client = mount()
  let read: ((value: PullRequest) => void) | undefined
  try {
    fireEvent.click(await screen.findByRole("button", { name: /Team PR 42/ }))
    const composer = await screen.findByPlaceholderText("Leave a comment…")
    fireEvent.change(composer, { target: { value: "Keep draft through identity error" } })
    const refreshedPr = { ...pr }
    vi.mocked(rpc.githubPrInbox).mockResolvedValue([refreshedPr])
    vi.mocked(rpc.githubPrBySlug).mockRejectedValue(new Error("Known detail unavailable"))
    await act(async () => discover(discovery))
    await screen.findByText("Known detail unavailable")
    expect(screen.getByPlaceholderText("Leave a comment…")).toBe(composer)
    expect(composer).toHaveProperty("value", "Keep draft through identity error")
    expect(screen.getByText("Before refresh")).toBeTruthy()
    expect(client.getQueryData(["github", "pr-inbox", "detail", "personal", "1", pr.repository, pr.number])).toBeUndefined()
    await waitFor(() => expect(client.getQueryData(["github", "pr-inbox", "personal", "1", 1])).toEqual([refreshedPr]))
    fireEvent.click(screen.getByRole("button", { name: /Team PR 42/ }))
    expect(screen.getByPlaceholderText("Leave a comment…")).toBe(composer)
    expect(composer).toHaveProperty("value", "Keep draft through identity error")
    vi.mocked(rpc.githubTeams).mockResolvedValue({ ...discovery, account: { id: "2", login: "other" } })
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
    await screen.findByText("Select a pull request to review it.")
    await act(async () => client.cancelQueries({ queryKey: ["github", "pr-inbox", "detail", "personal", "1"] }))
    vi.mocked(rpc.githubPrBySlug).mockImplementationOnce(() => new Promise((resolve) => { read = resolve }))
    fireEvent.click(await screen.findByRole("button", { name: /Team PR 42/ }))
    await waitFor(() => expect(client.getQueryState(["github", "pr-inbox", "detail", "personal", "2", pr.repository, pr.number])?.fetchStatus).toBe("fetching"))
    // The observer's last successful query is still unknown/App. It is not a B placeholder.
    expect(screen.queryByText("Before refresh")).toBeNull()
    expect(screen.queryByPlaceholderText("Leave a comment…")).toBeNull()
    await act(async () => read?.({ ...detail, body: "Independent B read" }))
    await screen.findByText("Independent B read")
    expect(screen.getByPlaceholderText("Leave a comment…")).toHaveProperty("value", "")
  } finally { read?.(detail); discover(discovery); client.clear() }
})

it("rejects personal comment, close and merge after a confirmed account switch until a new selection", async () => {
  vi.mocked(rpc.githubTeams).mockResolvedValue(discovery)
  vi.mocked(rpc.githubPrInbox).mockResolvedValue([pr])
  vi.mocked(rpc.githubPrBySlug).mockResolvedValue(detail)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { result } = renderHook(() => usePullRequestInbox(false), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })
  try {
    act(() => result.current.discover())
    await waitFor(() => expect(result.current.discovering).toBe(false))
    act(() => result.current.select(pr))
    await waitFor(() => expect(result.current.detail).toEqual(detail))
    vi.mocked(rpc.githubTeams).mockResolvedValue({ ...discovery, account: { id: "2", login: "other" } })
    act(() => result.current.discover())
    await waitFor(() => expect(result.current.discovering).toBe(false))
    await act(async () => {
      await expect(result.current.comment("Old draft")).rejects.toThrow("Select a pull request first")
      await expect(result.current.close()).rejects.toThrow("Select a pull request first")
      await expect(result.current.merge("merge")).rejects.toThrow("Select a pull request first")
    })
    expect(rpc.githubCommentBySlug).not.toHaveBeenCalled()
    expect(rpc.githubCloseBySlug).not.toHaveBeenCalled()
    expect(rpc.githubMergeBySlug).not.toHaveBeenCalled()
  } finally { client.clear() }
})
