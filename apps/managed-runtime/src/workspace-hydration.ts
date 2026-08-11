import type { WorkspaceProvisioningPlan } from "@jingler/core"

const WORKSPACE_PATH = "/workspace"

export interface WorkspaceCommandResult {
  readonly success: boolean
  readonly stdout: string
  readonly stderr: string
}

export interface WorkspaceCommandExecutor {
  readonly exec: (
    command: string,
    options: {
      readonly cwd: string
      readonly timeout: number
      readonly env?: Readonly<Record<string, string>>
    }
  ) => Promise<WorkspaceCommandResult>
}

export interface HydratedWorkspaceIdentity {
  readonly headSha: string
  readonly branch: string
  readonly path: string
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`

const run = async (
  executor: WorkspaceCommandExecutor,
  command: string,
  timeout = 120_000,
  env?: Readonly<Record<string, string>>
): Promise<string> => {
  const result = await executor.exec(command, {
    cwd: WORKSPACE_PATH,
    timeout,
    ...(env === undefined ? {} : { env })
  })
  if (!result.success) {
    throw new Error(`Workspace hydration failed: ${result.stderr.trim() || command}`)
  }
  return result.stdout.trim()
}

/** Recreates a clean exact Git base. Checkpoint changes are restored only afterwards. */
export const hydrateWorkspace = async (
  executor: WorkspaceCommandExecutor,
  plan: WorkspaceProvisioningPlan,
  repositoryUrl: string,
  options: {
    readonly authorizationHeader?: string
    readonly canonicalRepositoryUrl?: string
  } = {}
): Promise<HydratedWorkspaceIdentity> => {
  if (new URL(repositoryUrl).username || new URL(repositoryUrl).password) {
    throw new Error("Repository URL must not contain credentials")
  }
  const url = shellQuote(repositoryUrl)
  const sha = shellQuote(plan.headSha)
  const branch = shellQuote(plan.branch)
  await run(executor, "test -d .git || git init --quiet .")
  await run(
    executor,
    `git remote get-url origin >/dev/null 2>&1 && git remote set-url origin ${url} || git remote add origin ${url}`
  )
  // Keep even the short-lived proxy capability out of the command string.
  // Cloudflare records sandbox command text, whereas command environments are
  // not included in the execution log. Git's --config-env reads the header
  // without placing it in argv, the repository config, or the workspace.
  const authorization = options.authorizationHeader
    ? "--config-env=http.extraHeader=JINGLER_GIT_AUTHORIZATION "
    : ""
  await run(
    executor,
    `git ${authorization}fetch --no-tags --depth=1 origin ${sha}`,
    180_000,
    options.authorizationHeader === undefined
      ? undefined
      : { JINGLER_GIT_AUTHORIZATION: `Authorization: ${options.authorizationHeader}` }
  )
  await run(executor, `git checkout --quiet --force -B ${branch} ${sha}`)
  await run(executor, `git reset --quiet --hard ${sha}`)
  const [headSha, checkedOutBranch] = await Promise.all([
    run(executor, "git rev-parse HEAD"),
    run(executor, "git branch --show-current")
  ])
  if (headSha.toLowerCase() !== plan.headSha.toLowerCase()) {
    throw new Error("Hydrated workspace HEAD does not match the provisioning plan")
  }
  if (checkedOutBranch !== plan.branch) {
    throw new Error("Hydrated workspace branch does not match the provisioning plan")
  }
  if (options.canonicalRepositoryUrl) {
    await run(
      executor,
      `git remote set-url origin ${shellQuote(options.canonicalRepositoryUrl)}`
    )
  }
  return { headSha, branch: checkedOutBranch, path: WORKSPACE_PATH }
}
