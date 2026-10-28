/** Whether a shell command line opens a PR (`gh pr list`/`view` also print PR URLs and must not match). */
export const isGhPrCreate = (command: string): boolean => /\bgh\s+pr\s+create\b/u.test(command)

/**
 * The PR number a successful `gh pr create` printed, when it belongs to one of
 * `repoSlugs` (lowercase `owner/repo`). Null for any other command, repo, or output.
 */
export const createdPrFromToolOutput = (
  command: string,
  output: string,
  repoSlugs: ReadonlySet<string>
): number | null => {
  if (!isGhPrCreate(command)) return null
  for (const match of output.matchAll(/https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/gu)) {
    if (repoSlugs.has(`${match[1]}/${match[2]}`.toLowerCase())) return Number(match[3])
  }
  return null
}
