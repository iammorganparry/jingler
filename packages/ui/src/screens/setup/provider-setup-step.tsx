import type {
  AuthKind,
  CodexLoginMethod,
  ProviderCatalog,
  ProviderLoginEvent,
} from "@jingler/core";
import { Plus, ShieldCheck, X } from "lucide-react";
import { Button } from "../../components/button.js";
import { Callout } from "../../components/callout.js";
import { Eyebrow } from "../../components/eyebrow.js";
import { Spinner } from "../../components/loading.js";
import { ProviderIcon } from "../../components/provider-icon.js";
import { ProviderAuthForms } from "../../composites/provider-auth-forms.js";
import { providerAuthRouteLabel } from "../../lib/provider-connection-labels.js";

export interface ProviderSetupStepProps {
  catalog: ProviderCatalog | null;
  loginEvent: ProviderLoginEvent | null;
  busy: boolean;
  pendingAuthKind?: AuthKind | null;
  error: string | null;
  onConnectClaude: (token: string) => void;
  onStartCodex: (method: CodexLoginMethod) => void;
  onConnectApi: (providerId: string, apiKey: string) => void;
  onContinue: () => void;
  onSkip: () => void;
  onCancel: () => void;
  onRetry: () => void;
}

export function ProviderSetupStep({
  catalog,
  loginEvent,
  busy,
  pendingAuthKind = null,
  error,
  onConnectClaude,
  onStartCodex,
  onConnectApi,
  onContinue,
  onSkip,
  onCancel,
  onRetry,
}: ProviderSetupStepProps) {
  const canContinue =
    catalog?.connections.some(
      ({ connection }) => connection.status === "authenticated",
    ) === true;
  const authenticatedConnections =
    catalog?.connections.filter(
      ({ connection }) => connection.status === "authenticated",
    ) ?? [];
  const progressLabel =
    pendingAuthKind === "claude-setup-token"
      ? "Connecting Claude…"
      : pendingAuthKind === "openai-codex-oauth"
        ? "Connecting Codex…"
        : pendingAuthKind === "api-key"
          ? "Saving API key…"
          : "Updating provider connections…";

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

      {error && (
        <Callout tone="red">
          <div className="flex items-center justify-between gap-3">
            <span>{error}</span>
            <Button variant="ghost" size="sm" onClick={onRetry}>
              Retry
            </Button>
          </div>
        </Callout>
      )}

      {authenticatedConnections.length === 0 ? (
        authForms
      ) : (
        <>
          <div className="flex flex-col gap-2">
            {authenticatedConnections.map(({ connection }) => (
              <div
                key={connection.id}
                className="flex items-center gap-3 rounded-lg border border-line bg-hover px-3 py-2.5"
              >
                <span className="flex size-8 items-center justify-center rounded-md border border-line bg-canvas">
                  <ProviderIcon providerId={connection.providerId} size={17} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-medium text-text-bright">
                    {providerAuthRouteLabel(connection.authKind)}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground">
                    {connection.account?.displayLabel ??
                      connection.account?.fingerprint ??
                      connection.id}
                    {connection.subscription.planLabel
                      ? ` · ${connection.subscription.planLabel}`
                      : ""}
                    {connection.subscription.confirmedBillingRoute
                      ? ` · ${connection.subscription.confirmedBillingRoute}`
                      : ""}
                  </div>
                </div>
                <ShieldCheck size={15} className="text-green" />
              </div>
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
        >
          Continue
        </Button>
        <Button variant="ghost" onClick={onSkip} disabled={busy}>
          Skip for now
        </Button>
      </div>
      <p className="text-[11px] leading-[1.55] text-dim">
        Model choice happens when you create work. You can add or change
        provider connections later in Settings.
      </p>
    </>
  );
}
