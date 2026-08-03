import { app } from "../../src/app.js"

/** Preserve the existing BetterAuth/Hono surface while Next owns deployment. */
const handle = (request: Request): Response | Promise<Response> => app.fetch(request)

export const dynamic = "force-dynamic"
export const GET = handle
export const POST = handle
export const PUT = handle
export const PATCH = handle
export const DELETE = handle
export const OPTIONS = handle
