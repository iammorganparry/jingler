import { Cause, Option, Runtime } from "effect"

/** Recover the typed RPC failure that Effect wraps in a FiberFailure for Promises. */
export const unwrapRpcFailure = (error: unknown): unknown =>
  Runtime.isFiberFailure(error)
    ? Option.getOrElse(
        Cause.failureOption(error[Runtime.FiberFailureCauseId]),
        () => error
      )
    : error

export const rpcFailureTag = (error: unknown): string | undefined => {
  const failure = unwrapRpcFailure(error)
  return typeof failure === "object" && failure !== null && "_tag" in failure
    ? String(failure._tag)
    : undefined
}

export const rpcFailureReason = (error: unknown): string | undefined => {
  const failure = unwrapRpcFailure(error)
  return typeof failure === "object" && failure !== null && "reason" in failure
    ? String(failure.reason)
    : undefined
}

export const rpcFailureNumber = (
  error: unknown,
  field: string
): number | undefined => {
  const failure = unwrapRpcFailure(error)
  if (typeof failure !== "object" || failure === null || !(field in failure)) {
    return undefined
  }
  const value = failure[field as keyof typeof failure]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export const rpcFailureMessage = (
  error: unknown,
  fallback: string
): string => {
  const failure = unwrapRpcFailure(error)
  if (failure instanceof Error && failure.message.length > 0) {
    return failure.message
  }
  if (typeof failure === "object" && failure !== null && "message" in failure) {
    const message = failure.message
    if (typeof message === "string" && message.length > 0) return message
  }
  return fallback
}
