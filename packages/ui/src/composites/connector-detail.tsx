import type {
  ConnectorAuthField,
  ConnectorAuthType,
  ConnectorConnection,
  ConnectorProvider,
  ConnectorProviderDetail,
  OAuthClientInfo
} from "@starbase/core"
import { ExternalLink } from "lucide-react"
import * as React from "react"
import { AsyncButton } from "../components/async-button.js"
import { Badge } from "../components/badge.js"
import { Callout } from "../components/callout.js"
import { ConnectorLogo, logoHost } from "../components/connector-logo.js"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../components/dialog.js"
import { Input } from "../components/input.js"
import { SegmentedControl } from "../components/segmented-control.js"
import { StatusDot } from "../components/status-dot.js"

/**
 * One provider's detail sheet — the connect form, its OAuth scopes, and any
 * existing connections.
 *
 * The form's shape comes from `detail`, fetched per-provider when the card is
 * opened. That indirection is the point: the catalog list endpoint carries no
 * auth fields at all, so before this existed *every* provider fell through to a
 * single generic "API key" box — losing Linear's `lin_api_…` placeholder,
 * Notion's "Internal Integration Secret" label, and every custom-credential
 * provider's multi-field form.
 *
 * Secrets flow one way. Values go OUT through `onConnect` / `onSetOauthConfig`
 * and are never read back — there is no prop here that could carry one.
 */

/** Used only when a key-bearing provider's catalog entry declares no fields. */
const FALLBACK_FIELD: ConnectorAuthField = {
  name: "apiKey",
  label: "API key",
  kind: "password",
  required: true
}

/** OpenConnector's default connection alias — the one used when none is named. */
const DEFAULT_CONNECTION = "default"

const AUTH_LABEL: Record<ConnectorAuthType, string> = {
  oauth2: "OAuth",
  api_key: "API key",
  custom_credential: "Credentials",
  no_auth: "No auth"
}

/** Which key-bearing auth type a provider's connect PUT should declare. */
const keyAuthTypeOf = (
  authTypes: ReadonlyArray<ConnectorAuthType>
): "api_key" | "custom_credential" | null =>
  authTypes.includes("custom_credential")
    ? "custom_credential"
    : authTypes.includes("api_key")
      ? "api_key"
      : null

export interface ConnectorDetailProps {
  /** The catalog entry whose card was opened; null closes the dialog. */
  readonly provider: ConnectorProvider | null
  /** The per-service detail, or null while it loads (or if it failed). */
  readonly detail: ConnectorProviderDetail | null
  readonly detailLoading: boolean
  readonly detailError: string | null
  /** Every connection for THIS service (a provider may hold several aliases). */
  readonly connections: ReadonlyArray<ConnectorConnection>
  readonly oauthInfo: OAuthClientInfo | undefined
  readonly onClose: () => void
  readonly onConnect: (
    service: string,
    authType: "api_key" | "custom_credential",
    values: Record<string, string>,
    connectionName?: string
  ) => Promise<void>
  readonly onDisconnect: (service: string, connectionName: string | null) => Promise<void>
  readonly onSetOauthConfig: (
    provider: string,
    clientId: string,
    clientSecret: string
  ) => Promise<void>
  readonly onStartOauth: (service: string, connectionName?: string) => Promise<void>
}

export function ConnectorDetail({
  provider,
  detail,
  detailLoading,
  detailError,
  connections,
  oauthInfo,
  onClose,
  onConnect,
  onDisconnect,
  onSetOauthConfig,
  onStartOauth
}: ConnectorDetailProps) {
  return (
    <Dialog open={provider !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-lg">
        {provider ? (
          <DetailBody
            provider={provider}
            detail={detail}
            detailLoading={detailLoading}
            detailError={detailError}
            connections={connections}
            oauthInfo={oauthInfo}
            onClose={onClose}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
            onSetOauthConfig={onSetOauthConfig}
            onStartOauth={onStartOauth}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/**
 * Split from the wrapper so the whole form remounts (and every field resets)
 * when a different provider is opened — a `useEffect` reset on `provider.id`
 * would leave a typed secret alive for one render against the wrong provider.
 */
function DetailBody({
  provider,
  detail,
  detailLoading,
  detailError,
  connections,
  oauthInfo,
  onClose,
  onConnect,
  onDisconnect,
  onSetOauthConfig,
  onStartOauth
}: ConnectorDetailProps & { provider: ConnectorProvider }) {
  // The list entry's `authTypes` is a truthful preview while the detail loads,
  // so the dialog never flashes the wrong form and then swaps it.
  const authTypes = detail?.authTypes ?? provider.authTypes
  const supportsOauth = authTypes.includes("oauth2")
  const keyAuthType = keyAuthTypeOf(authTypes)
  const noAuth = authTypes.includes("no_auth") && keyAuthType === null && !supportsOauth
  const bothModes = supportsOauth && keyAuthType !== null

  const [mode, setMode] = React.useState<"oauth" | "key">(supportsOauth ? "oauth" : "key")
  const [connectionName, setConnectionName] = React.useState(DEFAULT_CONNECTION)
  const [values, setValues] = React.useState<Record<string, string>>({})
  const [clientId, setClientId] = React.useState("")
  const [clientSecret, setClientSecret] = React.useState("")

  const fields =
    detail && detail.fields.length > 0 ? detail.fields : keyAuthType ? [FALLBACK_FIELD] : []
  const needsClient = supportsOauth && oauthInfo !== undefined && !oauthInfo.hasClient
  const host = logoHost(provider.homepageUrl)
  // An alias of exactly "default" IS the default connection, which OpenConnector
  // addresses by omitting the name — sending it explicitly creates a second one.
  const alias = connectionName.trim()
  const namedAlias = alias.length === 0 || alias === DEFAULT_CONNECTION ? undefined : alias

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-2.5">
          <ConnectorLogo
            homepageUrl={provider.homepageUrl}
            iconUrl={provider.icon}
            name={provider.name}
            size={32}
          />
          <div className="min-w-0 flex-1">
            <DialogTitle className="flex items-center gap-2">
              <span className="truncate">{provider.name}</span>
              {connections.length > 0 ? (
                <Badge tone="green" size="xs">
                  connected
                </Badge>
              ) : null}
            </DialogTitle>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[10px] text-dim">{provider.id}</span>
              {authTypes.map((t) => (
                <Badge key={t} tone="neutral" size="xs">
                  {AUTH_LABEL[t]}
                </Badge>
              ))}
              {detail?.actionCount ? (
                <span className="text-[10px] text-dim">{detail.actionCount} actions</span>
              ) : null}
            </div>
          </div>
          {host ? (
            <a
              href={provider.homepageUrl ?? undefined}
              target="_blank"
              rel="noreferrer noopener"
              className="flex flex-none items-center gap-1 rounded-md border border-line bg-panel px-2 py-1 text-[11px] text-text hover:bg-surface"
            >
              Homepage
              <ExternalLink size={11} />
            </a>
          ) : null}
        </div>
        <DialogDescription className="mt-2">
          Credentials are stored by OpenConnector, never in Starbase.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-4">
        {detailError ? <Callout tone="red">{detailError}</Callout> : null}

        {connections.length > 0 ? (
          <section className="flex flex-col gap-1.5">
            <SectionLabel>Connections</SectionLabel>
            {connections.map((c) => (
              <ConnectionRow
                key={`${c.service}:${c.connectionName ?? ""}`}
                connection={c}
                onDisconnect={onDisconnect}
              />
            ))}
          </section>
        ) : null}

        {noAuth ? (
          <Callout tone="green">
            No auth needed — this provider is ready to use, and its actions are already
            available to every agent.
          </Callout>
        ) : (
          <section className="flex flex-col gap-3">
            {/* Deliberately NOT "Connect": that is the button's label, and two
                identically-named things in one dialog is ambiguous to a screen
                reader reading the sheet top to bottom. */}
            <SectionLabel>
              {connections.length > 0 ? "Add another connection" : "New connection"}
            </SectionLabel>

            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-muted-foreground">Connection name</span>
              <Input
                value={connectionName}
                onChange={(e) => setConnectionName(e.target.value)}
                placeholder={DEFAULT_CONNECTION}
              />
              <span className="text-[10px] text-dim">
                Use this name to select the account when running actions.
              </span>
            </label>

            {bothModes ? (
              <SegmentedControl
                className="self-start"
                value={mode}
                onChange={setMode}
                items={[
                  { value: "oauth", label: "OAuth" },
                  { value: "key", label: AUTH_LABEL[keyAuthType] }
                ]}
              />
            ) : null}

            {supportsOauth && (mode === "oauth" || !bothModes) ? (
              needsClient ? (
                <div className="flex flex-col gap-2 rounded-md border border-line bg-sunken p-2.5">
                  <span className="text-[11px] text-dim">
                    {provider.name} needs a local OAuth client first. Register one with redirect
                    URI <span className="font-mono text-text">{oauthInfo?.expectedRedirectUri}</span>
                  </span>
                  <Input
                    placeholder="Client ID"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                  />
                  <Input
                    type="password"
                    placeholder="Client secret"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                  />
                  <AsyncButton
                    pendingLabel="Saving…"
                    disabled={clientId.length === 0 || clientSecret.length === 0}
                    onClick={() => onSetOauthConfig(provider.id, clientId, clientSecret)}
                  >
                    Save OAuth app
                  </AsyncButton>
                </div>
              ) : (
                <AsyncButton
                  pendingLabel="Opening browser…"
                  onClick={async () => {
                    await onStartOauth(provider.id, namedAlias)
                    onClose()
                  }}
                >
                  Connect with OAuth
                </AsyncButton>
              )
            ) : null}

            {keyAuthType && (mode === "key" || !bothModes) ? (
              <div className="flex flex-col gap-2">
                {detail?.description ? (
                  <p className="text-[11px] leading-relaxed text-dim">{detail.description}</p>
                ) : null}
                {fields.map((f) => (
                  <label key={f.name} className="flex flex-col gap-1">
                    <span className="text-[11px] text-muted-foreground">{f.label}</span>
                    <Input
                      type={f.kind === "password" ? "password" : "text"}
                      placeholder={f.placeholder ?? f.label}
                      value={values[f.name] ?? ""}
                      onChange={(e) =>
                        setValues((v) => ({ ...v, [f.name]: e.target.value }))
                      }
                    />
                  </label>
                ))}
                <AsyncButton
                  pendingLabel="Connecting…"
                  disabled={
                    detailLoading ||
                    fields.some((f) => f.required && (values[f.name] ?? "").length === 0)
                  }
                  onClick={async () => {
                    await onConnect(provider.id, keyAuthType, values, namedAlias)
                    onClose()
                  }}
                >
                  Connect
                </AsyncButton>
              </div>
            ) : null}
          </section>
        )}

        {detail && detail.oauthScopes.length > 0 ? (
          <section className="flex flex-col gap-1.5">
            <SectionLabel>Scopes</SectionLabel>
            <p className="text-[10px] text-dim">
              Requested by this provider&apos;s actions when you connect with OAuth.
            </p>
            <div className="flex flex-wrap gap-1">
              {detail.oauthScopes.map((s) => (
                <Badge key={s} tone="neutral" size="xs">
                  {s}
                </Badge>
              ))}
            </div>
          </section>
        ) : null}

        {detailLoading ? (
          <span className="text-[11px] text-dim">Loading {provider.name}&apos;s details…</span>
        ) : null}
      </DialogBody>

      <DialogFooter>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-line bg-panel px-3 py-1.5 text-[12px] text-text hover:bg-surface"
        >
          Close
        </button>
      </DialogFooter>
    </>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  )
}

function ConnectionRow({
  connection,
  onDisconnect
}: {
  connection: ConnectorConnection
  onDisconnect: (service: string, connectionName: string | null) => Promise<void>
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-line bg-sunken px-[11px] py-[9px]">
      <StatusDot tone={connection.status === "connected" ? "bg-green" : "bg-yellow"} />
      <div className="min-w-0 flex-1">
        <span className="text-[12.5px] font-semibold text-text-bright">
          {connection.displayName ?? connection.connectionName ?? connection.service}
        </span>
        <div className="truncate font-mono text-[10px] text-dim">
          {connection.connectionName ?? DEFAULT_CONNECTION}
          {connection.accountId.length > 0 ? ` · ${connection.accountId}` : ""}
          {connection.grantedScopes.length > 0
            ? ` · ${connection.grantedScopes.length} scopes`
            : ""}
        </div>
      </div>
      <AsyncButton
        variant="danger"
        size="sm"
        pendingLabel="Removing…"
        // Pass the alias so a NAMED connection isn't deleted as the default one.
        onClick={() => onDisconnect(connection.service, connection.connectionName)}
      >
        Disconnect
      </AsyncButton>
    </div>
  )
}
