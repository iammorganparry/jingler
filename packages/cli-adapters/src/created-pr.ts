/** Whether a shell command line opens a PR (`gh pr list`/`view` also print PR URLs and must not match). */
export const isGhPrCreate = (command: string): boolean => /\bgh\s+pr\s+create\b/u.test(command)

/**
 * The PR a successful `gh pr create` printed, when it belongs to one of
 * `repoSlugs` (lowercase `owner/repo`). Null for any other command, repo, or output.
 */
export const createdPrFromToolOutput = (
  command: string,
  output: string,
  repoSlugs: ReadonlySet<string>
): { readonly repository: string; readonly number: number } | null => {
  if (!isGhPrCreate(command)) return null
  for (const match of output.matchAll(/https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/gu)) {
    const repository = `${match[1]}/${match[2]}`.toLowerCase()
    if (repoSlugs.has(repository)) return { repository, number: Number(match[3]) }
  }
  return null
}

const PORCELAIN_RECORD = /\n\s*\n/u

export type LinkCandidate = { readonly id: string; readonly slug: string | null; readonly branch: string | null }

/**
 * The checkout an agent-created PR belongs to, or null. A URL in the tool output proves nothing on
 * its own, so the PR must be authored by the signed-in gh user, live in a checkout's origin repo,
 * and have that checkout's branch as its head.
 */
export const checkoutForCreatedPr = (
  pr: { readonly repository: string; readonly author: string | null; readonly headRefName: string | null },
  viewerLogin: string | null,
  checkouts: ReadonlyArray<LinkCandidate>
): string | null => {
  if (!viewerLogin || pr.author?.toLowerCase() !== viewerLogin.toLowerCase() || !pr.headRefName) return null
  return checkouts.find((c) => c.slug === pr.repository.toLowerCase() && c.branch === pr.headRefName)?.id ?? null
}

/**
 * The worktree path `git worktree list --porcelain` shows with `branch` checked out, or null.
 * An agent can open a PR from a worktree it made itself; this finds it so the session can adopt it.
 */
export const worktreeForBranch = (porcelain: string, branch: string): string | null => {
  for (const record of porcelain.trim().split(PORCELAIN_RECORD)) {
    const lines = record.split("\n").map((line) => line.trim())
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length)
    if (path && lines.includes(`branch refs/heads/${branch}`)) return path
  }
  return null
}
