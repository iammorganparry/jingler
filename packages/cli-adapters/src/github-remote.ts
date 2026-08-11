/** Parse supported GitHub remote syntaxes without loading the GitHub API client. */
export const parseGitHubRemote = (
  remote: string
): { readonly owner: string; readonly repo: string } | null => {
  const trimmed = remote.trim()
  const match =
    trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i) ??
    trimmed.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i) ??
    trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i)
  if (!(match?.[1] && match[2])) return null
  return { owner: match[1], repo: match[2].replace(/\.git$/i, "") }
}
