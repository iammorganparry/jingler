export const OFFLOAD_SANDBOX_IDLE_SECONDS = 3 * 60 * 60

export const shouldDestroyStaleSandbox = (
  metadata: { readonly lastActiveAt: number },
  nowSeconds: number,
  idleSeconds = OFFLOAD_SANDBOX_IDLE_SECONDS
): boolean => nowSeconds - metadata.lastActiveAt >= idleSeconds
