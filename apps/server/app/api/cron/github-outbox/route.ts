import { env } from "../../../../src/env.js"
import { handleGitHubOutboxCron } from "../../../../src/github-outbox-cron.js"
import { drainGitHubOutboxes } from "../../../../src/github-routes.js"

export const dynamic = "force-dynamic"

export const GET = (request: Request): Promise<Response> =>
  handleGitHubOutboxCron(request, env.cronSecret, drainGitHubOutboxes)
