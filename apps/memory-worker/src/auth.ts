import type { MemoryWorkerEnv } from "./env.js"

export const ORGANIZATION_HEADER = "x-jingler-organization-id"
export const VAULT_ORGANIZATION_HEADER = "x-jingler-vault-organization"

export interface InternalPrincipal {
  readonly organizationId: string
}

const ORGANIZATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const WHITESPACE_PATTERN = /\s+/

export class MemoryAuthenticationError extends Error {
  override readonly name = "MemoryAuthenticationError"

  constructor(
    message: string,
    readonly status: 401 | 403 = 401
  ) {
    super(message)
  }
}

const validOrganizationId = (value: string): boolean => ORGANIZATION_ID_PATTERN.test(value)

/** Constant-work comparison for service credentials of equal length. */
export const secureCredentialEquals = (left: string, right: string): boolean => {
  const length = Math.max(left.length, right.length)
  let difference = left.length ^ right.length
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return difference === 0
}

const bearerCredential = (request: Request): string | undefined => {
  const authorization = request.headers.get("authorization")
  if (authorization === null) return
  const [scheme, credential, extra] = authorization.trim().split(WHITESPACE_PATTERN)
  return scheme?.toLocaleLowerCase("en-US") === "bearer" && credential !== undefined && extra === undefined
    ? credential
    : undefined
}

export const authenticateInternalRequest = (
  request: Request,
  env: Pick<MemoryWorkerEnv, "MEMORY_SERVICE_SECRET" | "MEMORY_SERVICE_SECRET_PREVIOUS">
): InternalPrincipal => {
  const credential = bearerCredential(request)
  const allowed = [env.MEMORY_SERVICE_SECRET, env.MEMORY_SERVICE_SECRET_PREVIOUS].filter(
    (candidate): candidate is string => candidate !== undefined && candidate.length > 0
  )
  if (
    credential === undefined ||
    credential.length === 0 ||
    !allowed.some((candidate) => secureCredentialEquals(credential, candidate))
  ) {
    throw new MemoryAuthenticationError("valid Next.js service credentials are required")
  }

  const organizationId = request.headers.get(ORGANIZATION_HEADER)?.trim()
  if (organizationId === undefined || !validOrganizationId(organizationId)) {
    throw new MemoryAuthenticationError("a valid organization scope is required", 403)
  }
  return { organizationId }
}

export const assertVaultOrganization = (value: string | null): string => {
  const organizationId = value?.trim()
  if (organizationId === undefined || !validOrganizationId(organizationId)) {
    throw new MemoryAuthenticationError("the trusted organization scope is missing", 403)
  }
  return organizationId
}
