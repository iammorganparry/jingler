export type ManagedRuntimeEnv = Env & {
  OFFLOAD_JOBS: R2Bucket
  OFFLOAD_WORKFLOW: Workflow<import("./offload-workflow.js").OffloadWorkflowInput>
  OFFLOAD_SANDBOX_LIFECYCLE: DurableObjectNamespace<
    import("./offload-sandbox-lifecycle.js").OffloadSandboxLifecycleObject
  >
  MANAGED_RUNTIME_ORIGIN: string
  /** Worker origin reachable from inside the sandbox network. */
  MANAGED_RUNTIME_SANDBOX_ORIGIN?: string
  MANAGED_RUNTIME_SERVICE_SECRET: string
  AUTH_STATE_SERVICE_SECRET: string
  MANAGED_RUNTIME_GRANT_SECRET: string
  MANAGED_RUNTIME_CERTIFICATIONS_BASE64?: string
  MANAGED_CONTROL_PLANE_URL: string
  MANAGED_RUNTIME_MAX_EGRESS_BYTES: string
  MANAGED_RUNTIME_MAX_CHECKPOINT_BYTES: string
  MANAGED_RUNTIME_CHECKPOINT_RETENTION_SECONDS: string
}

export const managedRuntimeSandboxOrigin = (env: {
  readonly MANAGED_RUNTIME_ORIGIN: string
  readonly MANAGED_RUNTIME_SANDBOX_ORIGIN?: string
}): string => env.MANAGED_RUNTIME_SANDBOX_ORIGIN ?? env.MANAGED_RUNTIME_ORIGIN
