import { NativeEndpointLogin, type NativeEndpointLoginActions } from "../../composites/native-endpoint-login.js"
import type {
  AgentEndpointCatalog,
  ProviderCatalog,
} from "@jingler/core";
import { Plus } from "lucide-react";
import { Button } from "../../components/button.js";
import { Callout } from "../../components/callout.js";
import { Eyebrow } from "../../components/eyebrow.js";
import { HarnessCard } from "../../composites/harness-card.js";
import { ProviderAuthForms } from "../../composites/provider-auth-forms.js";
import type { ProviderConnectRequest } from "../../composites/provider-connect-sheet.js";
import {
  entitlementIssueLabel,
  providerAuthRouteLabel,
} from "../../lib/provider-connection-labels.js";

export interface ProviderSetupStepProps {
  catalog: ProviderCatalog | null;
  nativeEndpointLogin?: NativeEndpointLoginActions;
  endpointCatalog?: AgentEndpointCatalog | null;
  busy: boolean;
  error: string | null;
  /** Which machine failure state the step is in, if any. */
  failure?: "loadFailed" | "completionFailed" | null;
  onConnect: (request: ProviderConnectRequest) => void;
  onContinue: () => void;
  onSkip: () => void;
  onRetry: () => void;
}

const canUseProviderCatalog = (catalog: ProviderCatalog | null, endpoints: AgentEndpointCatalog["endpoints"]): boolean =>
  endpoints.some(({ endpoint, models }) => endpoint.status === "ready" && models.some(({ selectable }) => selectable)) ||
  catalog?.connections.some(({ connection }) => connection.status === "authenticated") === true

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
  busy,
  error,
  failure = null,
  onConnect,
  onContinue,
  onSkip,
  onRetry,
}: ProviderSetupStepProps) {
  const detectedEndpoints = endpointCatalog?.endpoints ?? []
  const canContinue = canUseProviderCatalog(catalog, detectedEndpoints)
  const { authenticatedConnections, unconfirmedConnections } = splitConnections(catalog)
  const continueBlockedReason = continueBlockedText(busy, canContinue)

  const authForms = (
    <ProviderAuthForms busy={busy} onConnect={onConnect} />
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
