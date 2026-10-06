import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import type { SeedSession } from "./fixtures.js"
import { appShell, expect, sessionRow, test } from "./fixtures.js"

const installCli = () => {
  const root = mkdtempSync(join(tmpdir(), "jingler-team-pr-"))
  const bin = join(root, "bin")
  mkdirSync(bin)
  const controlPath = join(root, "control.json")
  const logPath = join(root, "requests.jsonl")
  let control = { accountId: 1, fail: false, partial: false, teams: true, repoPath: "", sha: "", switchAtFetch: false }
  const update = (patch: Partial<typeof control>) => {
    control = { ...control, ...patch }
    writeFileSync(controlPath, JSON.stringify(control))
  }
  update({})
  writeFileSync(logPath, "")
  const script = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const joined = args.join(' ')
const control = JSON.parse(fs.readFileSync(${JSON.stringify(controlPath)}, 'utf8'))
const pinned = process.env.GH_TOKEN === 'fixture-private-' + control.accountId
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({args, pinned}) + '\\n')
const output = (value) => { console.log(JSON.stringify(value)); process.exit(0) }
const item = (number, repository = 'acme/widget') => ({
  number, title: 'Team PR ' + number, state: 'open', draft: number === 42,
  html_url: 'https://github.com/' + repository + '/pull/' + number,
  updated_at: '2026-01-01T00:00:00Z', user: {login:'teammate'}, labels:[], comments:0
})
if (args[0] === 'auth' && args[1] === 'status') process.exit(0)
if (args[0] === 'auth' && args[1] === 'token') { console.log('fixture-private-' + control.accountId); process.exit(0) }
if (args[0] === 'repo' && args[1] === 'view') { console.log('acme/widget'); process.exit(0) }
if (args[0] === 'pr') {
  const number = Number(args[2] || 42)
  if (args[1] !== 'view' && args[1] !== 'list') process.exit(0)
  const pr = {
    state:'OPEN', number, title:'Team PR ' + number, body:'Team detail from the pinned CLI account.',
    url:'https://github.com/acme/widget/pull/' + number, author:{login:'teammate'},
    headRefName:'feature' + number, baseRefName:'main', headRefOid:control.sha,
    headRepository:{nameWithOwner:'acme/widget'}, isDraft:number === 42, commits:[],
    additions:3, deletions:1, labels:[], reviews:[], comments:[], reviewRequests:[], statusCheckRollup:[],
    mergeable:'MERGEABLE', mergeStateStatus:'CLEAN'
  }
  output(args[1] === 'list' ? [pr] : pr)
}
if (args[0] === 'api') {
  const endpoint = args[1]
  if (endpoint === 'user') {
    if (args.includes('--jq')) { console.log('octocat'); process.exit(0) }
    output({id:control.accountId,login:'octocat'})
  }
  if (endpoint === 'user/teams') output(control.teams ? [[{id:7, organization:{login:'acme'}, slug:'platform', name:'Platform'}],[{id:8, organization:{login:'acme'},slug:'web',name:'Web'}]] : [[]])
  if (endpoint.includes('/memberships/')) output({state:'active'})
  if (endpoint.endsWith('/members')) output([[{login:'parent'}],[{login:'child',inherited:true}]])
  if (endpoint.endsWith('/repos')) output([[{full_name:'acme/widget'}],[{full_name:'acme/unregistered'}]])
  if (endpoint === 'search/issues') {
    if (control.fail) { console.error('HTTP 403 SAML SSO required; private stderr'); process.exit(1) }
    const q = args.find(a => a.startsWith('q=')) || ''
    let items = q.includes('team-review-requested:') ? [item(42)]
      : q.includes('author:parent') ? [item(43)]
      : q.includes('author:child') ? [item(44)]
      : q.includes('repo:acme/unregistered') ? [item(46,'acme/unregistered')]
      : [item(45)]
    output({total_count:items.length,incomplete_results:control.partial,items})
  }
  if (endpoint === 'repos/acme/widget') output({id:7,node_id:'R_7',clone_url:control.repoPath,ssh_url:null})
  if (endpoint.endsWith('/files')) output([[]])
  if (endpoint === 'graphql') {
    if (joined.includes('search(query:')) output([{data:{viewer:{login:'octocat'},search:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}])
    const field = joined.includes('commits(first:100') ? 'commits' : 'reviewThreads'
    output([{data:{repository:{pullRequest:{[field]:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}}}])
  }
}
console.error('Unsupported scripted CLI command')
process.exit(1)
`
  writeFileSync(join(bin, "gh"), script)
  chmodSync(join(bin, "gh"), 0o755)
  return {
    root, update,
    installGitTransport: () => {
      const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim()
      writeFileSync(join(bin, "git"), `#!/usr/bin/env node
const fs = require('node:fs')
const cp = require('node:child_process')
const args = process.argv.slice(2)
const control = JSON.parse(fs.readFileSync(${JSON.stringify(controlPath)}, 'utf8'))
if (args.includes('fetch') && args.some(arg => arg.startsWith('https://github.com/'))) {
  const url = args[args.length - 2]
  if (control.switchAtFetch) fs.writeFileSync(${JSON.stringify(controlPath)}, JSON.stringify({...control,accountId:2,switchAtFetch:false}))
  if (process.env.GIT_ALLOW_PROTOCOL !== 'https' || process.env.JINGLER_GIT_ASKPASS_GITHUB_ONLY !== '1') process.exit(2)
  const auth = cp.spawnSync(process.env.GIT_ASKPASS, ["Password for 'https://x-access-token@github.com/acme/widget.git':"], {env:process.env,encoding:'utf8'})
  const denied = cp.spawnSync(process.env.GIT_ASKPASS, ["Password for 'https://x-access-token@other.example/widget.git':"], {env:process.env,encoding:'utf8'})
  const credentialPinned = auth.status === 0 && auth.stdout === 'fixture-private-1' && denied.status !== 0
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({args, pinned:credentialPinned}) + '\\n')
  if (!credentialPinned) process.exit(3)
  const cwd = args.includes('-C') ? args[args.indexOf('-C') + 1] : process.cwd()
  const redirect = cp.spawnSync(${JSON.stringify(realGit)}, [...args.slice(0,args.indexOf('fetch')),'config','--get-urlmatch','http.followRedirects',url], {env:process.env,encoding:'utf8'})
  if (redirect.stdout.trim() !== 'false') process.exit(4)
  const child = cp.spawnSync(${JSON.stringify(realGit)}, ['-C',cwd,'fetch','--no-tags','--',control.repoPath,args[args.length - 1]], {env:{...process.env,GIT_ALLOW_PROTOCOL:'file'},stdio:'inherit'})
  process.exit(child.status || 0)
}
const child = cp.spawnSync(${JSON.stringify(realGit)}, args, {env:process.env,stdio:'inherit'})
process.exit(child.status || 0)
`)
      chmodSync(join(bin, "git"), 0o755)
    },
    env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, GH_HOST: "hostile.example", GH_DEBUG: "api" },
    requests: () => readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { args: string[]; pinned: boolean }),
  }
}

const sessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [{
  id: "session_team_pr", repo: "widget", branch: "feature42", title: "Existing team session",
  status: "idle", diff: { added: 3, removed: 1 }, prNumber: 42,
  costUsd: 0, tokens: 0, updatedAt: "2026-01-01T00:00:00.000Z",
  worktreePath: repoPath, mode: "accept-edits",
}]

test("team queues use CLI only, refresh partial/access failures, and reuse local pickup", async ({ launchApp }) => {
  test.setTimeout(120_000)
  const cli = installCli()
  try {
    const { window, githubServer } = await launchApp({
      configured: true, withRepo: true, sessions,
      githubApp: { connected: true, prs: [] },
      e2eEnv: cli.env,
      seed: ({ repoPath }) => {
        const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath, encoding: "utf8" }).trim()
        execFileSync("git", ["branch", "feature45"], { cwd: repoPath })
        cli.update({ repoPath, sha })
      },
    })
    await expect(appShell(window)).toBeVisible()
    await window.getByTestId("pull-requests-sidebar-item").click()
    const inbox = window.getByTestId("pull-request-inbox")
    const scope = inbox.getByRole("combobox", { name: "Pull request scope" })
    await expect(scope).toBeEnabled()
    await scope.selectOption("7")
    await expect(inbox.getByRole("button", { name: /Team PR 42/ })).toBeVisible()
    await expect(inbox.getByText("Draft", { exact: true })).toBeVisible()
    await inbox.getByRole("button", { name: /Team PR 42/ }).click()
    await expect(inbox.getByText("Team detail from the pinned CLI account.")).toBeVisible()
    await inbox.getByRole("button", { name: "Open session" }).click()
    await expect(inbox).not.toBeVisible()
    await window.getByTestId("pull-requests-sidebar-item").click()
    await expect(scope).toBeEnabled()
    await expect(scope).toHaveValue("7")

    const queue = inbox.getByRole("combobox", { name: "Team pull request queue" })
    await queue.selectOption("authored")
    await expect(inbox.getByRole("button", { name: /Team PR 43/ })).toBeVisible()
    await expect(inbox.getByRole("button", { name: /Team PR 44/ })).toBeVisible()
    await expect(inbox.getByRole("button", { name: /Team PR 42/ })).toHaveCount(0)
    await queue.selectOption("repositories")
    await expect(inbox.getByRole("button", { name: /Team PR 45/ })).toBeVisible()
    await expect(inbox.getByRole("button", { name: /Team PR 46/ })).toBeVisible()
    await inbox.getByRole("button", { name: /Team PR 46/ }).click()
    await expect(inbox.getByRole("button", { name: "Create session" })).toBeDisabled()
    await expect(inbox.getByRole("button", { name: "Create session" })).toHaveAttribute("title", "Add this repository as a local project to create a session.")

    await inbox.getByRole("button", { name: /Team PR 45/ }).click()
    await expect(inbox.getByRole("heading", { name: "Team PR 45" })).toBeVisible()
    const appWrites = githubServer.operations.length
    await inbox.getByPlaceholder("Leave a comment…").fill("Team inbox comment")
    await inbox.getByRole("button", { name: "Comment", exact: true }).click()
    await expect.poll(() => cli.requests().some((request) => request.args[0] === "pr" && request.args[1] === "comment" && request.pinned)).toBe(true)
    expect(githubServer.operations).toHaveLength(appWrites)

    cli.update({ partial: true })
    await inbox.getByRole("button", { name: "Refresh", exact: true }).click()
    await expect(inbox.getByText("Partial results", { exact: true })).toBeVisible()
    await expect(inbox.getByRole("button", { name: /Team PR 45/ })).toBeVisible()
    cli.update({ partial: false, fail: true })
    await inbox.getByRole("button", { name: "Refresh", exact: true }).click()
    await expect(inbox.getByText("No pull requests loaded. Some results could not be retrieved.")).toBeVisible()
    await expect(inbox.getByText(/Authorize your GitHub CLI credentials/)).toBeVisible()
    await expect(inbox.getByText(/private stderr/)).toHaveCount(0)

    cli.update({ fail: false })
    await inbox.getByRole("button", { name: "Refresh", exact: true }).click()
    await expect(inbox.getByRole("button", { name: /Team PR 45/ })).toBeVisible()
    const searches = cli.requests().filter((request) => request.args[1] === "search/issues")
    expect(searches.length).toBeGreaterThan(3)
    expect(searches.every((request) => request.pinned && request.args.includes("github.com"))).toBe(true)
    expect(cli.requests().some((request) => request.args.includes("--add-assignee") || request.args.includes("--add-reviewer"))).toBe(false)
  } finally { rmSync(cli.root, { recursive: true, force: true }) }
})

test("team pickup creates a session using pinned HTTPS fetches and files reuse that session", async ({ launchApp }) => {
  test.setTimeout(120_000)
  const cli = installCli()
  cli.installGitTransport()
  try {
    const { window, home, githubServer } = await launchApp({
      configured: true, withRepo: true, sessions: [],
      githubApp: { connected: true, prs: [] }, e2eEnv: cli.env,
      seed: ({ home, repoPath }) => {
        writeFileSync(join(home, "jingler", "projects.json"), JSON.stringify([{
          id: "project-widget", name: "widget", path: repoPath, imported: true, availability: "available",
          createdAt: "2026-01-01", updatedAt: "2026-01-01",
        }]))
        const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath, encoding: "utf8" }).trim()
        execFileSync("git", ["branch", "feature45"], { cwd: repoPath })
        execFileSync("git", ["config", "http.https://github.com/.extraHeader", "Authorization: unrelated-account"], { cwd: repoPath })
        execFileSync("git", ["config", "credential.https://github.com.helper", "must-not-run"], { cwd: repoPath })
        execFileSync("git", ["config", "http.https://github.com/.followRedirects", "true"], { cwd: repoPath })
        cli.update({ repoPath, sha, switchAtFetch: true })
      },
    })
    await expect(appShell(window)).toBeVisible()
    await window.getByTestId("pull-requests-sidebar-item").click()
    const inbox = window.getByTestId("pull-request-inbox")
    const scope = inbox.getByRole("combobox", { name: "Pull request scope" })
    await expect(scope).toBeEnabled()
    await scope.selectOption("7")
    await inbox.getByRole("combobox", { name: "Team pull request queue" }).selectOption("repositories")
    await inbox.getByRole("button", { name: /Team PR 45/ }).click()
    await expect(inbox.getByRole("heading", { name: "Team PR 45" })).toBeVisible()
    const appWrites = githubServer.operations.length
    await inbox.getByRole("button", { name: "Create session" }).click()
    await expect(window.getByTestId("new-session-view")).toBeVisible()
    await window.getByRole("button", { name: "Create workspace" }).click()
    await expect(sessionRow(window, "Team PR 45")).toBeVisible({ timeout: 30_000 })
    const persisted = JSON.parse(readFileSync(join(home, "jingler", "sessions.json"), "utf8"))
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({ prNumber: 45, branch: "feature45", githubSlug: "acme/widget" })
    expect(persisted[0]).not.toHaveProperty("githubCliAccountId")
    const fetches = cli.requests().filter((request) => request.args.includes("fetch"))
    expect(fetches).toHaveLength(2)
    expect(fetches.every((request) => request.pinned)).toBe(true)
    expect(JSON.parse(readFileSync(join(cli.root, "control.json"), "utf8")).accountId).toBe(2)
    expect(githubServer.operations).toHaveLength(appWrites)
    cli.update({ accountId: 1, switchAtFetch: false })
    await window.getByTestId("pull-requests-sidebar-item").click()
    await expect(scope).toBeEnabled()
    await inbox.getByRole("button", { name: /Team PR 45/ }).click()
    await expect(inbox.getByRole("heading", { name: "Team PR 45" })).toBeVisible()
    await inbox.getByRole("tab", { name: /Files changed/ }).click()
    await expect(inbox).not.toBeVisible()
    await expect(window.getByTestId("view-tab-files").first()).toBeVisible()
    expect(JSON.parse(readFileSync(join(home, "jingler", "sessions.json"), "utf8"))).toHaveLength(1)
  } finally { rmSync(cli.root, { recursive: true, force: true }) }
})

test("team account changes reject actions until refresh, and removed memberships clear saved selection", async ({ launchApp }) => {
  const cli = installCli()
  try {
    const { window } = await launchApp({ configured: true, withRepo: true, sessions, e2eEnv: cli.env })
    await expect(appShell(window)).toBeVisible()
    await window.getByTestId("pull-requests-sidebar-item").click()
    const inbox = window.getByTestId("pull-request-inbox")
    const scope = inbox.getByRole("combobox", { name: "Pull request scope" })
    await expect(scope).toBeEnabled()
    await scope.selectOption("7")
    await inbox.getByRole("button", { name: /Team PR 42/ }).click()
    await expect(inbox.getByText("Team detail from the pinned CLI account.")).toBeVisible()
    cli.update({ accountId: 2 })
    await inbox.getByPlaceholder("Leave a comment…").fill("Wrong account must not write")
    await inbox.getByRole("button", { name: "Comment", exact: true }).click()
    await expect(inbox.getByText(/The GitHub CLI account changed/)).toBeVisible()
    expect(cli.requests().filter((request) => request.args[0] === "pr" && request.args[1] === "comment")).toHaveLength(0)
    await inbox.getByRole("button", { name: "Refresh", exact: true }).click()
    await expect(scope).toBeEnabled()
    await expect(scope).toHaveValue("")
    await scope.selectOption("7")
    await expect(inbox.getByRole("button", { name: /Team PR 42/ })).toBeVisible()
    cli.update({ teams: false })
    await inbox.getByRole("button", { name: "Refresh", exact: true }).click()
    await expect(scope).toHaveValue("")
    await expect(inbox.getByText("No organization teams are visible to your GitHub CLI account.")).toBeVisible()
  } finally { rmSync(cli.root, { recursive: true, force: true }) }
})
