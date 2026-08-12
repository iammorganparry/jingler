import type {
  CodexLoginMethod,
  ProviderCatalog,
  ProviderLoginEvent,
} from "@jingler/core";
import { ShieldCheck, X } from "lucide-react";
import { Button } from "../../components/button.js";
import { Callout } from "../../components/callout.js";
import { Eyebrow } from "../../components/eyebrow.js";
import { Spinner } from "../../components/loading.js";
import { StatusDot } from "../../components/status-dot.js";
import { ProviderAuthForms } from "../../composites/provider-auth-forms.js";
import {
  providerAuthRouteLabel,
  providerStatusTone,
} from "../../lib/provider-connection-labels.js";

export interface ProviderSetupStepProps {
  catalog: ProviderCatalog | null;
  loginEvent: ProviderLoginEvent | null;
  busy: boolean;
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

      <ProviderAuthForms
        busy={busy}
        onConnectClaude={onConnectClaude}
        onStartCodex={onStartCodex}
        onConnectApi={onConnectApi}
      />

      {busy && (
        <div className="flex items-center justify-between rounded-lg border border-line bg-hover px-3 py-2 text-[12px] text-muted-foreground">
          <span className="flex items-center gap-2">
            <Spinner size={13} /> Connecting…
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

      {catalog?.connections.map(({ connection }) => (
        <div
          key={connection.id}
          className="flex flex-col gap-3 rounded-lg border border-line bg-hover p-3"
        >
          <div className="flex items-start gap-2">
            <StatusDot
              tone={providerStatusTone(connection.status)}
              size={8}
              glow={connection.status === "authenticated"}
            />
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-medium text-text-bright">
                {providerAuthRouteLabel(connection.authKind)}
              </div>
              <div className="mt-0.5 font-mono text-[10.5px] text-muted-foreground">
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
            {connection.status === "authenticated" && (
              <ShieldCheck size={15} className="text-green" />
            )}
          </div>
        </div>
      ))}

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
