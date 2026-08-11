export const matchesGitRepositoryScope = (
  owner: string,
  repository: string,
  expectedSlug: string
): boolean =>
  `${owner}/${repository.replace(/\.git$/u, "")}`.toLowerCase() ===
  expectedSlug.toLowerCase()
