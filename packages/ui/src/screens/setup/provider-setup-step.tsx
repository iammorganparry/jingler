import { NativeEndpointLogin, type NativeEndpointLoginActions } from "../../composites/native-endpoint-login.js"
import type {
  AgentEndpointCatalog,
  AuthKind,
  CodexLoginMethod,
  ProviderCatalog,
  ProviderLoginEvent,
} from "@jingler/core";
import { Plus, X } from "lucide-react";
import { Button } from "../../components/button.js";
import { Callout } from "../../components/callout.js";
import { Eyebrow } from "../../components/eyebrow.js";
import { Spinner } from "../../components/loading.js";
import { HarnessCard } from "../../composites/harness-card.js";
import { ProviderAuthForms } from "../../composites/provider-auth-forms.js";
import {
  entitlementIssueLabel,
  providerAuthRouteLabel,
} from "../../lib/provider-connection-labels.js";

export interface ProviderSetupStepProps {
  catalog: ProviderCatalog | null;
  nativeEndpointLogin?: NativeEndpointLoginActions;
  endpointCatalog?: AgentEndpointCatalog | null;
  loginEvent: ProviderLoginEvent | null;
  busy: boolean;
  pendingAuthKind?: AuthKind | null;
  error: string | null;
  /** Which machine failure state the step is in, if any. */
  failure?: "loadFailed" | "completionFailed" | null;
  onConnectClaude: (token: string) => void;
  onStartCodex: (method: CodexLoginMethod) => void;
  onConnectApi: (providerId: string, apiKey: string) => void;
  onContinue: () => void;
  onSkip: () => void;
  onCancel: () => void;
  onRetry: () => void;
}

const canUseProviderCatalog = (catalog: ProviderCatalog | null, endpoints: AgentEndpointCatalog["endpoints"]): boolean =>
  endpoints.some(({ endpoint, models }) => endpoint.status === "ready" && models.some(({ selectable }) => selectable)) ||
  catalog?.connections.some(({ connection }) => connection.status === "authenticated") === true

const providerProgressLabel = (pendingAuthKind: AuthKind | null) =>
    pendingAuthKind === "claude-setup-token"
      ? "Connecting Claude…"
      : pendingAuthKind === "openai-codex-oauth"
        ? "Connecting Codex…"
        : pendingAuthKind === "api-key"
          ? "Saving API key…"
          : "Updating provider connections…";

const failureText = (failure: "loadFailed" | "completionFailed" | null, error: string): string =>
  failure === "loadFailed"
    ? "Couldn't load providers"
    : failure === "completionFailed"
      ? "Couldn't save setup"
      : error;

const continueBlockedText = (busy: boolean, canContinue: boolean): string | null =>
  busy ? "Finishing sign-in…" : canContinue ? null : "Connect a provider to continue, or skip for now.";

type CatalogConnection = NonNullable<ProviderSetupStepProps["catalog"]>["connections"][number]["connection"]

const accountKey = (connection: CatalogConnection) =>
  `${connection.providerId}:${connection.authKind}:${connection.account?.fingerprint ?? ""}`

/** Authenticated connections, plus deduped unconfirmed ones no authenticated attempt supersedes. */
function splitConnections(catalog: ProviderSetupStepProps["catalog"]) {
  const all = catalog?.connections ?? []
  const authenticatedConnections = all.filter(({ connection }) => connection.status === "authenticated")
  const authenticatedAccounts = new Set(authenticatedConnections.map(({ connection }) => accountKey(connection)))
  const seenUnconfirmed = new Set<string>()
  const unconfirmedConnections = all.filter(({ connection }) => {
    if (connection.status !== "entitlement-unconfirmed") return false
    const key = accountKey(connection)
    if (authenticatedAccounts.has(key) || seenUnconfirmed.has(key)) return false
    seenUnconfirmed.add(key)
    return true
  })
  return { authenticatedConnections, unconfirmedConnections }
}

const connectionDetail = (connection: CatalogConnection): string =>
  [
    connection.account?.displayLabel ?? connection.account?.fingerprint ?? connection.id,
    connection.subscription.planLabel,
    connection.subscription.confirmedBillingRoute
  ].filter(Boolean).join(", ")

export function ProviderSetupStep({
  catalog,
  endpointCatalog = null,
  nativeEndpointLogin,
  loginEvent,
  busy,
  pendingAuthKind = null,
  error,
  failure = null,
  onConnectClaude,
  onStartCodex,
  onConnectApi,
  onContinue,
  onSkip,
  onCancel,
  onRetry,
}: ProviderSetupStepProps) {
  const detectedEndpoints = endpointCatalog?.endpoints ?? []
  const canContinue = canUseProviderCatalog(catalog, detectedEndpoints)
  const { authenticatedConnections, unconfirmedConnections } = splitConnections(catalog)
  const continueBlockedReason = continueBlockedText(busy, canContinue)
  const progressLabel = providerProgressLabel(pendingAuthKind)

  const authForms = (
    <ProviderAuthForms
      busy={busy}
      pendingAuthKind={pendingAuthKind}
      onConnectClaude={onConnectClaude}
      onStartCodex={onStartCodex}
      onConnectApi={onConnectApi}
    />
  );

  return (
    <>
      <div className="flex flex-col gap-2.5">
        <Eyebrow>Welcome · 3 of 4</Eyebrow>
        <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-text-bright">
          Connect a model provider
        </h1>
        <p className="text-[13px] leading-[1.6] text-muted-foreground">
          Choose the exact account and billing route Jingler should use. A
          subscription connection never falls back to an API key.
        </p>
      </div>

      {detectedEndpoints.length > 0 && (
        <div aria-label="Detected agent runtimes" className="rounded-xl border border-line bg-sunken p-3">
          <div className="text-xs font-semibold text-text-bright">Detected agent runtimes</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {detectedEndpoints.map(({ endpoint }) => (
              <div
                key={endpoint.id}
                className={endpoint.status === "ready"
                  ? "rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-muted-foreground"
                  : "rounded-full border border-line bg-canvas px-2.5 py-1 text-xs text-muted-foreground"}
              >
                <NativeEndpointLogin endpoint={endpoint} actions={nativeEndpointLogin} />
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <Callout tone="red">
          <div className="flex items-center justify-between gap-3">
            <span title={error}>
              {failureText(failure, error)}
            </span>
            <Button variant="ghost" size="sm" onClick={onRetry}>
              Retry
            </Button>
          </div>
        </Callout>
      )}

      {unconfirmedConnections.map(({ connection }) => (
        <Callout key={connection.id} tone="blue">
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">
              {providerAuthRouteLabel(connection.authKind)} needs attention
            </span>
            <span>{entitlementIssueLabel(connection.subscription)}</span>
          </div>
        </Callout>
      ))}

      {authenticatedConnections.length === 0 ? (
        authForms
      ) : (
        <>
          <div className="flex flex-col gap-2">
            {authenticatedConnections.map(({ connection }) => (
              <HarnessCard
                key={connection.id}
                providerId={connection.providerId}
                name={providerAuthRouteLabel(connection.authKind)}
                detail={connectionDetail(connection)}
                status="ready"
              />
            ))}
          </div>
          <details
            key={authenticatedConnections.length}
            className="rounded-lg border border-line bg-sunken p-3"
          >
            <summary className="flex cursor-pointer list-none items-center gap-2 text-[12px] font-medium text-text-body">
              <Plus size={13} className="text-blue" /> Add another account
            </summary>
            <div className="mt-3 border-t border-line pt-3">{authForms}</div>
          </details>
        </>
      )}

      {busy && (
        <div className="flex items-center justify-between rounded-lg border border-line bg-hover px-3 py-2 text-[12px] text-muted-foreground">
          <span className="flex items-center gap-2">
            <Spinner size={13} /> {progressLabel}
          </span>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            <X size={13} /> Cancel
          </Button>
        </div>
      )}

      {loginEvent?.type === "device-code" && (
        <div className="rounded-lg border border-blue/40 bg-hover px-3 py-3">
          <div className="text-[11px] text-muted-foreground">
            Enter this device code in the opened browser
          </div>
          <div className="mt-1 font-mono text-[20px] font-semibold tracking-[0.18em] text-text-bright">
            {loginEvent.userCode}
          </div>
          <div className="mt-1 truncate font-mono text-[10px] text-dim">
            {loginEvent.verificationUri}
          </div>
        </div>
      )}
      {(loginEvent?.type === "info" || loginEvent?.type === "progress") && (
        <div className="text-[11px] text-muted-foreground">
          {loginEvent.message}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2.5 pt-1">
        <Button
          variant="primary"
          onClick={onContinue}
          disabled={busy || !canContinue}
          aria-describedby={continueBlockedReason ? "provider-continue-reason" : undefined}
        >
          Continue
        </Button>
        <Button variant="ghost" onClick={onSkip} disabled={busy}>
          Skip for now
        </Button>
      </div>
      {continueBlockedReason && (
        <p id="provider-continue-reason" className="text-[11px] text-muted-foreground">
          {continueBlockedReason}
        </p>
      )}
      <p className="text-[11px] leading-[1.55] text-dim">
        Model choice happens when you create work. You can add or change
        provider connections later in Settings.
      </p>
    </>
  );
}
