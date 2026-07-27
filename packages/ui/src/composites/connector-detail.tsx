import type {
  ConnectorAuthField,
  ConnectorAuthMode,
  ConnectorAuthType,
  ConnectorConnection,
  ConnectorProvider,
  ConnectorProviderDetail,
  OAuthClientInfo
} from "@jingler/core"
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
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../components/dialog.js"
import { Input } from "../components/input.js"
import { SegmentedControl } from "../components/segmented-control.js"
import { StatusDot } from "../components/status-dot.js"
import { AUTH_LABEL } from "../lib/connector-labels.js"

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

/** Which key-bearing auth type a provider's connect PUT should declare. */
const keyAuthTypeOf = (
  authTypes: ReadonlyArray<ConnectorAuthType>
): "api_key" | "custom_credential" | null =>
  authTypes.includes("custom_credential")
    ? "custom_credential"
    : authTypes.includes("api_key")
      ? "api_key"
      : null

/**
 * A mode's tab label. The catalog's own name ("Encoded API Key", "Webhook Key")
 * only earns the tab when there is another key mode to tell it apart from —
 * with one, the generic "API key" reads better and the descriptor's label is
 * already the field's label directly below.
 */
const keyModeLabel = (mode: ConnectorAuthMode, total: number): string =>
  total > 1 ? (mode.label ?? AUTH_LABEL[mode.type]) : AUTH_LABEL[mode.type]

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
          // Keyed by provider so React REMOUNTS the form on any provider change,
          // not just when `provider` happens to pass through null on close.
          // Without the key, an A→B swap reconciles the same instance and carries
          // a typed api key — plus the connection name and the chosen auth mode —
          // straight into the other provider's form. The grid can't do that swap
          // today (the dialog is modal, so a card is unclickable while one is
          // open), but this component is exported, and "safe because of how the
          // one current caller behaves" is not a property worth relying on for a
          // credential.
          <DetailBody
            key={provider.id}
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
 * The form itself, split from the wrapper so that mounting it is conditional and
 * it can be keyed. Both matter: the split alone would NOT reset anything on an
 * A→B provider swap (React reconciles the same element type in the same position
 * and keeps its state) — the `key={provider.id}` at the call site is what forces
 * the remount, and every field with it.
 *
 * A `useEffect` reset on `provider.id` was the obvious alternative and is worse:
 * effects run AFTER paint, so the previous provider's typed secret would live for
 * one render inside the new provider's form.
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

  /**
   * The credential forms on offer. Until `detail` lands we only know the auth
   * TYPES from the catalog list entry, so stand in a single generic form — the
   * same preview the header shows, replaced the moment the real descriptors
   * arrive.
   */
  const keyModes: ReadonlyArray<ConnectorAuthMode> =
    detail && detail.keyModes.length > 0
      ? detail.keyModes
      : keyAuthType
        ? [{ type: keyAuthType, label: null, description: null, fields: [FALLBACK_FIELD] }]
        : []

  /** One tab per way to connect: OAuth, then each credential form. */
  const tabs = [
    ...(supportsOauth ? [{ id: "oauth", label: AUTH_LABEL.oauth2 }] : []),
    ...keyModes.map((m, i) => ({ id: `key:${i}`, label: keyModeLabel(m, keyModes.length) }))
  ]
  const [selected, setSelected] = React.useState(tabs[0]?.id ?? "oauth")
  // The tab set can change under us when `detail` resolves (a second key mode
  // appears), so never trust the stored id blindly.
  const activeId = tabs.some((t) => t.id === selected) ? selected : (tabs[0]?.id ?? "oauth")
  const activeKeyMode = activeId.startsWith("key:")
    ? keyModes[Number(activeId.slice(4))]
    : undefined
  /**
   * Blank once a connection exists, pre-filled "default" when none does.
   *
   * PUT is create-or-REPLACE, so a name that matches an existing connection
   * overwrites its credential. Pre-filling "default" under an "Add another
   * connection" heading therefore aimed the form squarely at the connection the
   * operator was trying to keep — an empty field they must fill is the only
   * version where the default answer is the safe one.
   */
  const [connectionName, setConnectionName] = React.useState(
    connections.length > 0 ? "" : DEFAULT_CONNECTION
  )
  const [values, setValues] = React.useState<Record<string, string>>({})
  const [clientId, setClientId] = React.useState("")
  const [clientSecret, setClientSecret] = React.useState("")

  const fields = activeKeyMode?.fields ?? []

  /**
   * Only the fields of the SELECTED mode, and only the ones with a typed value.
   *
   * `values` outlives the field set it was typed into — twice over. While
   * `detail` loads, a key-bearing provider renders the generic `apiKey` fallback
   * (editable, since only the Connect BUTTON is disabled during the fetch), and
   * when the real descriptors land that stale entry is still in state. Switching
   * between two credential modes does the same thing. OpenConnector rejects any
   * field the chosen `authType` does not declare — `Unexpected credential field:
   * apiKey.` — so either would turn a correctly-filled form into a 400 with
   * nothing on screen to explain it.
   *
   * Filtering on `!== undefined` rather than mapping every field keeps the
   * existing shape: an optional field the operator never touched stays absent
   * instead of being submitted as an empty string.
   */
  const submitValues = Object.fromEntries(
    fields
      .filter((f) => values[f.name] !== undefined)
      .map((f) => [f.name, values[f.name] as string])
  )
  const needsClient = supportsOauth && oauthInfo !== undefined && !oauthInfo.hasClient
  const host = logoHost(provider.homepageUrl)
  // An alias of exactly "default" IS the default connection: OpenConnector
  // documents `connectionName` as "defaults to default" and echoes that name back
  // when the parameter is omitted, so the two forms address the SAME connection.
  // We send the omitted form because it is the canonical one — every layer below
  // then agrees on a single representation, rather than one path saying "default"
  // and another saying nothing for the same thing.
  const alias = connectionName.trim()
  const namedAlias = alias.length === 0 || alias === DEFAULT_CONNECTION ? undefined : alias

  /**
   * Which connection this form would actually write to, and whether one is
   * already there.
   *
   * `PUT /api/connections/{service}` is "create or REPLACE", so a name that
   * matches an existing connection silently overwrites its credential. That is a
   * legitimate thing to want — rotating an expired key is exactly this — so the
   * UI warns rather than blocks. What it must not do is arrive at that state by
   * default.
   */
  const targetAlias = alias.length === 0 ? DEFAULT_CONNECTION : alias
  const existingNames = new Set(connections.map((c) => c.connectionName ?? DEFAULT_CONNECTION))
  // Only once they have TYPED a colliding name. A blank field also resolves to
  // the default connection, but warning about it before the operator has touched
  // anything is noise — and the Connect button is already disabled for blank,
  // which is the signal that fits an untouched field.
  const replacesExisting = alias.length > 0 && existingNames.has(targetAlias)
  /** Adding alongside an existing connection needs a name that isn't blank. */
  const nameMissing = connections.length > 0 && alias.length === 0

  return (
    <>
      {/* `DialogHeader` is a ROW by default (`flex items-center gap-3`), which
          laid the description out BESIDE the provider block and squeezed it
          until the auth chips wrapped into a column. This header is two stacked
          bands, so it overrides the axis. */}
      {/*
        One line: who this is, and whether it works. Everything else earns its
        place lower down or not at all — the slug and the auth-type chips both
        duplicated what the form immediately below already says (its tabs name
        the auth modes; its field labels name the credential), and a header that
        restates the body is just noise above the thing you came to do.
      */}
      <DialogHeader className="gap-2.5">
        <ConnectorLogo
          homepageUrl={provider.homepageUrl}
          iconUrl={provider.icon}
          name={provider.name}
          size={26}
        />
        <DialogTitle className="flex min-w-0 items-center gap-2">
          <span className="truncate">{provider.name}</span>
          {/* Status-aware, matching the grid card's dot: a grant that has been
              started but not consented is listed, yet cannot run an action —
              calling that "connected" here while the row below shows an amber
              dot contradicts itself. */}
          {connections.some((c) => c.status === "connected") ? (
            <Badge tone="green" size="xs">
              connected
            </Badge>
          ) : connections.length > 0 ? (
            <Badge tone="yellow" size="xs">
              pending
            </Badge>
          ) : null}
          {detail?.actionCount ? (
            <span className="flex-none text-[10px] font-normal text-dim">
              {detail.actionCount} actions
            </span>
          ) : null}
        </DialogTitle>
        {/* Icon only, and `mr-6` to clear the dialog's own close button, which
            is absolutely positioned at `right-3.5 top-[11px]`. */}
        {host ? (
          <a
            href={provider.homepageUrl ?? undefined}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={`${provider.name} homepage`}
            title={host}
            className="mr-6 flex size-6 flex-none items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface hover:text-text"
          >
            <ExternalLink size={13} />
          </a>
        ) : null}
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
                placeholder={connections.length > 0 ? "e.g. work" : DEFAULT_CONNECTION}
              />
              <span className="text-[10px] text-dim">
                Use this name to select the account when running actions.
              </span>
            </label>

            {/* Replacing is a real thing to want — rotating an expired key is
                exactly this — so say what will happen rather than block it. */}
            {replacesExisting ? (
              <Callout tone="yellow">
                A connection named <span className="font-mono">{targetAlias}</span> already
                exists. Connecting will replace its stored credential.
              </Callout>
            ) : null}

            {/* Only worth a control when there is a choice — most providers
                offer exactly one way in. */}
            {tabs.length > 1 ? (
              <SegmentedControl
                className="self-start"
                value={activeId}
                onChange={setSelected}
                items={tabs.map((t) => ({ value: t.id, label: t.label }))}
              />
            ) : null}

            {supportsOauth && activeId === "oauth" ? (
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
                  // Same guard as the key form: an OAuth grant is written under a
                  // connection name too, so a blank one would land on the default.
                  disabled={nameMissing}
                  onClick={async () => {
                    await onStartOauth(provider.id, namedAlias)
                    onClose()
                  }}
                >
                  Connect with OAuth
                </AsyncButton>
              )
            ) : null}

            {activeKeyMode ? (
              <div className="flex flex-col gap-2">
                {activeKeyMode.description ? (
                  <p className="text-[11px] leading-relaxed text-dim">
                    {activeKeyMode.description}
                  </p>
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
                    nameMissing ||
                    fields.some((f) => f.required && (values[f.name] ?? "").length === 0)
                  }
                  onClick={async () => {
                    // The SELECTED mode's type, not the provider's — a provider
                    // offering both sends each form under its own authType, and
                    // the instance rejects a field the other one declares.
                    await onConnect(provider.id, activeKeyMode.type, submitValues, namedAlias)
                    onClose()
                  }}
                >
                  Connect
                </AsyncButton>
              </div>
            ) : null}

            {/* Sits with the form, not in the header: it is a reassurance about
                the secret you are ABOUT TO TYPE, so it belongs where you type
                it. In the header it rode along on every provider you opened,
                including the `no_auth` ones that store nothing at all. */}
            <p className="text-[10px] leading-relaxed text-dim">
              Credentials are stored by OpenConnector, never in Jingler.
            </p>
          </section>
        )}

        {detail && detail.oauthScopes.length > 0 ? (
          <ScopeList scopes={detail.oauthScopes} />
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

/** How many scopes show before the list collapses behind a toggle. */
const SCOPE_PREVIEW = 5

/**
 * The OAuth scopes a grant will request, capped at five with a toggle.
 *
 * Uncapped this is a wall: Slack asks for 15, and a long scope list pushed the
 * Close button off the bottom of the sheet while telling the operator nothing
 * they could act on. Five is enough to judge the shape of the request; the rest
 * are one click away for anyone actually auditing it.
 */
function ScopeList({ scopes }: { scopes: ReadonlyArray<string> }) {
  const [expanded, setExpanded] = React.useState(false)
  const hidden = scopes.length - SCOPE_PREVIEW
  const shown = expanded ? scopes : scopes.slice(0, SCOPE_PREVIEW)

  return (
    <section className="flex flex-col gap-1.5">
      <SectionLabel>Scopes</SectionLabel>
      <p className="text-[10px] text-dim">
        Requested by this provider&apos;s actions when you connect with OAuth.
      </p>
      <div className="flex flex-wrap items-center gap-1">
        {shown.map((s) => (
          <Badge key={s} tone="neutral" size="xs">
            {s}
          </Badge>
        ))}
        {hidden > 0 ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            // The collapsed label counts what is hidden rather than saying
            // "Show all", so the operator can tell at a glance whether the
            // remainder is worth opening.
            className="rounded-md px-1.5 py-0.5 text-[10px] text-blue transition-colors hover:bg-hover"
          >
            {expanded ? "Show less" : `+${hidden} more`}
          </button>
        ) : null}
      </div>
    </section>
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
  const label = connection.displayName ?? connection.connectionName ?? connection.service
  return (
    // Named so each row is addressable: a provider can hold several connections,
    // and their Disconnect buttons are otherwise identical to a screen reader.
    <div
      role="group"
      aria-label={label}
      className="flex items-center gap-2.5 rounded-lg border border-line bg-sunken px-[11px] py-[9px]"
    >
      <StatusDot tone={connection.status === "connected" ? "bg-green" : "bg-yellow"} />
      <div className="min-w-0 flex-1">
        <span className="text-[12.5px] font-semibold text-text-bright">
          {label}
        </span>
        <div className="truncate font-mono text-[10px] text-dim">
          {connection.connectionName ?? DEFAULT_CONNECTION}
          {connection.accountId.length > 0 ? ` · ${connection.accountId}` : ""}
          {connection.grantedScopes.length > 0
            ? ` · ${connection.grantedScopes.length} scopes`
            : ""}
        </div>
      </div>
      {connection.removable ? (
        <AsyncButton
          variant="danger"
          size="sm"
          pendingLabel="Removing…"
          // Pass the alias so a NAMED connection isn't deleted as the default one.
          onClick={() => onDisconnect(connection.service, connection.connectionName)}
        >
          Disconnect
        </AsyncButton>
      ) : (
        // Nothing is stored, so there is nothing to disconnect. Offering the
        // button anyway would be the worst kind: DELETE answers 200, the app
        // reports success, the list refetches — and the row is still there, with
        // no error to explain why the destructive action did nothing.
        <Badge tone="neutral" size="xs">
          built in
        </Badge>
      )}
    </div>
  )
}
