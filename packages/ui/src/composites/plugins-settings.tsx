/**
 * Settings › Plugins — the front door for folder-drop installs.
 *
 * ## What this screen is for
 *
 * Plugins arrive by being copied into `~/jingler/plugins`, which means the
 * operator's mental model is "a folder either works or it doesn't". This screen
 * exists to answer, for each folder, WHICH — and when it doesn't, why, in the
 * decoder's own words rather than a shrug.
 *
 * A plugin that fails to load is the interesting case, not the exception. A
 * missing tab and a broken plugin look identical from the session pane, so a
 * failure that is merely absent from this list would leave the operator with no
 * way to tell "I installed it wrong" from "it isn't installed".
 *
 * ## Why granted credentials live here too
 *
 * There is no `permissions` field in a manifest; a plugin asks for credentials
 * at the moment it needs them and the operator consents once. That is only half
 * a bargain unless the other half — seeing what was granted and taking it back —
 * is somewhere obvious. It is the section below the list.
 */
import { useState } from "react"
import { useMachine } from "@xstate/react"
import {
  AlertTriangle,
  Boxes,
  FolderOpen,
  KeyRound,
  Plus,
  Trash2
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import type {
  AuthSessionInfo,
  LoadedPlugin,
  PluginCatalog,
  PluginSettingValue,
  PluginSettingsSnapshot,
  SettingContribution
} from "@jingler/core"
import { cn } from "../lib/cn.js"
import { Badge } from "../components/badge.js"
import { Button } from "../components/button.js"
import { Input } from "../components/input.js"
import { SettingsCard, SettingsRow } from "../components/settings-row.js"
import { Toggle } from "../components/toggle.js"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/beui/select.js"
import { pluginSecretSettingMachine } from "./plugin-secret-setting-machine.js"

export interface PluginsSettingsProps {
  /** Everything under `~/jingler/plugins`, including what failed to decode. */
  catalog: PluginCatalog | null
  /**
   * Plugins whose MODULE failed to load, keyed by id.
   *
   * Separate from `catalog.failed` because they fail at different stages: a
   * manifest that will not decode never becomes a plugin at all, whereas this
   * one has a valid manifest and a broken `ui` entry. The operator does not care
   * about that distinction, so they are shown together — but only one of the two
   * is knowable by the process that reads the directory.
   */
  loadErrors?: ReadonlyArray<{ readonly id: string; readonly message: string }>
  /** Renderer-resolved plugin marks; invalid or missing assets are omitted. */
  pluginIcons?: Readonly<Record<string, LucideIcon | undefined>>
  /**
   * Why the operator's last action failed, if it did.
   *
   * Every callback below returns a promise, and this component invokes them as
   * `void onX()` — a rejection with nowhere to go became an unhandled promise
   * rejection visible only in devtools. The install flow made that plainly wrong:
   * the two commonest outcomes of choosing a folder are "no
   * `jingler.plugin.json` in the selected folder" and "already installed,
   * uninstall it first", and both presented as the picker closing and nothing
   * happening. Exactly the silently-absent failure the rest of this system
   * refuses to ship.
   */
  actionError?: string | null
  /** Dismiss {@link actionError}. */
  onDismissActionError?: () => void
  onSetEnabled: (pluginId: string, enabled: boolean) => void | Promise<void>
  onUninstall: (pluginId: string) => void | Promise<void>
  onReveal: (pluginId: string) => void | Promise<void>
  /** Opens a folder picker and copies the chosen directory into `pluginsDir`. */
  onInstallFromFolder?: () => void | Promise<void>
  /** Credentials plugins currently hold. */
  authSessions?: ReadonlyArray<AuthSessionInfo>
  onRevokeAuth?: (pluginId: string, providerId: string) => void | Promise<void>
  /** Renderer-safe snapshots: ordinary values plus secret configured booleans. */
  settings?: Readonly<Record<string, PluginSettingsSnapshot | undefined>>
  onSetSetting?: (
    pluginId: string,
    settingId: string,
    value: PluginSettingValue
  ) => Promise<void>
  onSetSecret?: (pluginId: string, settingId: string, value: string) => Promise<void>
  onClearSecret?: (pluginId: string, settingId: string) => Promise<void>
}

const contributionCount = (plugin: LoadedPlugin): number => {
  const c = plugin.manifest.contributes
  if (!c) return 0
  return (
    (c.tabs?.length ?? 0) +
    (c.panes?.length ?? 0) +
    (c.commands?.length ?? 0) +
    (c.settings?.length ?? 0)
  )
}

/** Compact 32px geometry shared by every generated setting control. */
const controlClass = "h-8 w-[220px] rounded-[6px] px-2.5 text-[13px]"

const SettingHelp = ({ setting }: { setting: SettingContribution }) => (
  <>
    {setting.description && <p>{setting.description}</p>}
    {setting.documentationUrl && (
      <a
        href={setting.documentationUrl}
        target="_blank"
        rel="noreferrer"
        className="mt-1 inline-block text-blue hover:underline"
      >
        Documentation
      </a>
    )}
  </>
)

const SettingLabel = ({ setting }: { setting: SettingContribution }) => (
  <label htmlFor={`plugin-setting-input-${setting.id}`}>{setting.label}</label>
)

function OrdinarySettingControl({
  pluginId,
  setting,
  value,
  onSave
}: {
  pluginId: string
  setting: SettingContribution
  value: PluginSettingValue | null
  onSave: NonNullable<PluginsSettingsProps["onSetSetting"]>
}) {
  const [draft, setDraft] = useState<PluginSettingValue>(
    value ?? (setting.type === "boolean" ? false : setting.type === "number" ? 0 : "")
  )
  const stringDraft = String(draft)
  const patternValid =
    !setting.validation || new RegExp(setting.validation.pattern).test(stringDraft)
  const valid =
    patternValid &&
    (setting.type !== "number" ||
      (typeof draft === "number" && Number.isFinite(draft)))

  return (
    <div data-testid={`plugin-setting-${setting.id}`}>
      <SettingsRow
        label={<SettingLabel setting={setting} />}
        help={<SettingHelp setting={setting} />}
        control={
          <div className="flex items-center gap-2">
            {setting.type === "boolean" ? (
              <Toggle
                checked={Boolean(draft)}
                onCheckedChange={setDraft}
                aria-label={setting.label}
              />
            ) : setting.type === "enum" ? (
              <Select value={stringDraft} onValueChange={setDraft}>
                <SelectTrigger
                  ariaLabel={setting.label}
                  className={cn(
                    controlClass,
                    "border border-line bg-panel text-text outline-none focus:border-blue/50 focus:ring-2 focus:ring-ring/40"
                  )}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(setting.options ?? []).map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id={`plugin-setting-input-${setting.id}`}
                aria-label={setting.label}
                type={setting.type === "number" ? "number" : "text"}
                value={stringDraft}
                placeholder={setting.placeholder}
                pattern={setting.validation?.pattern}
                title={setting.validation?.message}
                onChange={(event) =>
                  setDraft(
                    setting.type === "number"
                      ? event.currentTarget.valueAsNumber
                      : event.currentTarget.value
                  )
                }
                className={controlClass}
              />
            )}
            <Button
              variant="secondary"
              size="sm"
              disabled={!valid}
              onClick={() => void onSave(pluginId, setting.id, draft)}
            >
              Save
            </Button>
          </div>
        }
      />
    </div>
  )
}

function SecretSettingControl({
  pluginId,
  setting,
  configured,
  onSave,
  onClear
}: {
  pluginId: string
  setting: SettingContribution
  configured: boolean
  onSave: NonNullable<PluginsSettingsProps["onSetSecret"]>
  onClear: NonNullable<PluginsSettingsProps["onClearSecret"]>
}) {
  const [snapshot, send] = useMachine(pluginSecretSettingMachine, {
    input: {
      configured,
      save: (value) => onSave(pluginId, setting.id, value),
      clear: () => onClear(pluginId, setting.id)
    }
  })
  const { draft } = snapshot.context
  const editing = snapshot.matches("editing") || snapshot.matches("saving")
  const busy = snapshot.matches("saving") || snapshot.matches("removing")
  const valid =
    draft.length > 0 &&
    (!setting.validation || new RegExp(setting.validation.pattern).test(draft))

  return (
    <div data-testid={`plugin-setting-${setting.id}`}>
      <SettingsRow
        label={<SettingLabel setting={setting} />}
        help={<SettingHelp setting={setting} />}
        control={
          <div className="flex items-center gap-2">
            {editing ? (
              <Input
                id={`plugin-setting-input-${setting.id}`}
                aria-label={setting.label}
                type="password"
                autoComplete="off"
                value={draft}
                placeholder={setting.placeholder}
                pattern={setting.validation?.pattern}
                title={setting.validation?.message}
                disabled={busy}
                onChange={(event) => send({ type: "CHANGE", value: event.currentTarget.value })}
                className={controlClass}
              />
            ) : (
              <Input
                id={`plugin-setting-input-${setting.id}`}
                aria-label={setting.label}
                type="password"
                value="configured"
                readOnly
                className={controlClass}
              />
            )}
            {editing ? (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!valid || busy}
                  onClick={() => send({ type: "SAVE" })}
                >
                  {snapshot.matches("saving") ? "Saving…" : "Save"}
                </Button>
                {configured && (
                  <Button variant="ghost" size="sm" onClick={() => send({ type: "CANCEL" })}>
                    Cancel
                  </Button>
                )}
              </>
            ) : (
              <>
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => send({ type: "REPLACE" })}>
                  Replace
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => send({ type: "REMOVE" })}>
                  Remove
                </Button>
              </>
            )}
          </div>
        }
      />
    </div>
  )
}

function Row({
  plugin,
  loadError,
  onSetEnabled,
  onUninstall,
  onReveal,
  settings,
  onSetSetting,
  onSetSecret,
  onClearSecret,
  pluginIcon
}: {
  plugin: LoadedPlugin
  loadError?: string
  onSetEnabled: PluginsSettingsProps["onSetEnabled"]
  onUninstall: PluginsSettingsProps["onUninstall"]
  onReveal: PluginsSettingsProps["onReveal"]
  settings?: PluginSettingsSnapshot
  onSetSetting?: PluginsSettingsProps["onSetSetting"]
  onSetSecret?: PluginsSettingsProps["onSetSecret"]
  onClearSecret?: PluginsSettingsProps["onClearSecret"]
  pluginIcon?: LucideIcon
}) {
  const [confirming, setConfirming] = useState(false)
  const { manifest } = plugin
  const broken = loadError ?? plugin.activationError
  const PluginIcon = pluginIcon ?? Boxes

  return (
    <li data-testid={`plugin-row-${manifest.id}`}>
      <SettingsCard>
        <SettingsRow
          label={
            <span className="flex items-baseline gap-2">
              <PluginIcon
                size={16}
                className={cn("flex-none self-center", plugin.enabled ? "text-text-bright" : "text-muted-foreground")}
              />
              <span className="truncate">{manifest.name}</span>
              <span className="flex-none font-mono text-[11px] font-normal text-muted-foreground">
                {manifest.version}
              </span>
              {plugin.builtin && (
                <Badge tone="count" size="xs">
                  built-in
                </Badge>
              )}
            </span>
          }
          help={
            <>
              <div className="truncate font-mono text-[11px]">{manifest.id}</div>
              {manifest.description && (
                <p className="mt-1 text-text-body">{manifest.description}</p>
              )}
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                <span>
                  {contributionCount(plugin)} contribution
                  {contributionCount(plugin) === 1 ? "" : "s"}
                </span>
                {/* No activation events means the host half never starts — worth
                    saying plainly, because "does this run code?" is the question an
                    operator actually has about an installed plugin. */}
                <span>
                  {manifest.activationEvents?.length
                    ? `activates on ${manifest.activationEvents.join(", ")}`
                    : "no background process"}
                </span>
              </div>
            </>
          }
          control={
            <Toggle
              checked={plugin.enabled}
              onCheckedChange={(next: boolean) => void onSetEnabled(manifest.id, next)}
              aria-label={`Enable ${manifest.name}`}
            />
          }
        />

        {broken && (
          <div
            data-testid={`plugin-error-detail-${manifest.id}`}
            className="flex items-start gap-2 px-4 py-3"
          >
            <AlertTriangle size={13} className="mt-0.5 flex-none text-muted-foreground" />
            {/* The decoder's own message, verbatim. A friendlier summary would
                throw away the line number that makes it fixable. */}
            <span className="font-mono text-[11px] leading-[1.5] text-text-body">
              {broken}
            </span>
          </div>
        )}

        {manifest.contributes?.settings?.map((setting) =>
          setting.type === "secret" && onSetSecret && onClearSecret ? (
            <SecretSettingControl
              key={`${setting.id}:${settings?.secrets[setting.id] ?? false}`}
              pluginId={manifest.id}
              setting={setting}
              configured={settings?.secrets[setting.id] ?? false}
              onSave={onSetSecret}
              onClear={onClearSecret}
            />
          ) : setting.type !== "secret" && onSetSetting ? (
            <OrdinarySettingControl
              key={`${setting.id}:${String(settings?.values[setting.id] ?? "")}`}
              pluginId={manifest.id}
              setting={setting}
              value={settings?.values[setting.id] ?? null}
              onSave={onSetSetting}
            />
          ) : null
        )}

        <div className="flex items-center gap-2 px-4 py-2">
          <Button variant="ghost" size="sm" onClick={() => void onReveal(manifest.id)}>
            <FolderOpen size={12} /> Reveal
          </Button>
          {!plugin.builtin &&
            (confirming ? (
              <span className="flex items-center gap-2 text-[12px]">
                <span className="text-text-body">Remove this plugin&rsquo;s folder?</span>
                <Button
                  variant="danger"
                  size="sm"
                  data-testid={`plugin-uninstall-confirm-${manifest.id}`}
                  onClick={() => void onUninstall(manifest.id)}
                >
                  Delete
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </span>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                data-testid={`plugin-uninstall-${manifest.id}`}
                onClick={() => setConfirming(true)}
              >
                <Trash2 size={12} /> Uninstall
              </Button>
            ))}
        </div>
      </SettingsCard>
    </li>
  )
}

export function PluginsSettings({
  catalog,
  loadErrors = [],
  pluginIcons = {},
  actionError = null,
  onDismissActionError,
  onSetEnabled,
  onUninstall,
  onReveal,
  onInstallFromFolder,
  authSessions = [],
  onRevokeAuth,
  settings = {},
  onSetSetting,
  onSetSecret,
  onClearSecret
}: PluginsSettingsProps) {
  const plugins = catalog?.plugins ?? []
  const undecodable = catalog?.failed ?? []
  const errorFor = new Map(loadErrors.map((e) => [e.id, e.message]))

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[15px] font-semibold text-text">Plugins</h2>
          <p className="mt-1 max-w-[520px] text-[12.5px] leading-[1.6] text-dim">
            Plugins add tabs, panes and commands. Drop a folder into{" "}
            <code className="font-mono text-text-body">~/jingler/plugins</code> and it
            appears here, no restart.{" "}
            <span className="text-text-body">
              Plugins run with the same access as Jingler itself; install ones you
              trust.
            </span>
          </p>
        </div>
        {onInstallFromFolder && (
          <Button
            variant="secondary"
            size="sm"
            data-testid="plugin-install-folder"
            onClick={() => void onInstallFromFolder()}
            className="flex-none"
          >
            <Plus size={13} /> Install from folder…
          </Button>
        )}
      </div>

      {/* Directly under the Install button, because that is the control whose
          failures the operator most needs explained and the one they were just
          looking at. */}
      {actionError !== null && (
        <div
          data-testid="plugin-action-error"
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-state-failed/50 bg-panel px-3 py-2.5"
        >
          <AlertTriangle size={14} className="mt-0.5 flex-none text-state-failed" />
          <span className="flex-1 text-[12.5px] leading-[1.6] text-text-body">
            {actionError}
          </span>
          {onDismissActionError && (
            <Button
              variant="ghost"
              size="sm"
              data-testid="plugin-action-error-dismiss"
              onClick={onDismissActionError}
              className="flex-none"
            >
              Dismiss
            </Button>
          )}
        </div>
      )}

      {plugins.length === 0 && undecodable.length === 0 ? (
        <div
          data-testid="plugins-empty"
          className="rounded-xl border border-dashed border-line px-4 py-8 text-center"
        >
          <Boxes size={28} className="mx-auto text-muted-foreground" strokeWidth={1.5} />
          <div className="mt-2 text-[13px] text-text">No plugins installed</div>
          <div className="mt-1 text-[12px] text-dim">
            Copy a plugin folder into{" "}
            <code className="font-mono">~/jingler/plugins</code> to get started.
          </div>
        </div>
      ) : (
        <ul className="flex flex-col gap-4">
          {plugins.map((plugin) => (
            <Row
              key={plugin.manifest.id}
              plugin={plugin}
              loadError={errorFor.get(plugin.manifest.id)}
              pluginIcon={pluginIcons[plugin.manifest.id]}
              onSetEnabled={onSetEnabled}
              onUninstall={onUninstall}
              onReveal={onReveal}
              settings={settings[plugin.manifest.id]}
              onSetSetting={onSetSetting}
              onSetSecret={onSetSecret}
              onClearSecret={onClearSecret}
            />
          ))}
        </ul>
      )}

      {undecodable.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-[13px] font-medium text-text">Could not be read</h3>
          <p className="text-[12px] text-dim">
            These folders are in your plugins directory but their{" "}
            <code className="font-mono">jingler.plugin.json</code> could not be
            decoded, so they contribute nothing.
          </p>
          <div data-testid="plugins-undecodable">
            <SettingsCard>
              {undecodable.map((failure) => (
                <SettingsRow
                  key={failure.dir}
                  label={
                    <span className="flex items-center gap-2">
                      <AlertTriangle size={13} className="flex-none text-muted-foreground" />
                      <span className="font-mono text-[12px]">{failure.dir}</span>
                      <Badge tone="count" size="xs">
                        {failure.kind}
                      </Badge>
                    </span>
                  }
                  help={<span className="font-mono text-[11px]">{failure.message}</span>}
                  control={null}
                />
              ))}
            </SettingsCard>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <h3 className="flex items-center gap-1.5 text-[13px] font-medium text-text">
          <KeyRound size={13} className="text-dim" /> Granted access
        </h3>
        <p className="max-w-[520px] text-[12px] leading-[1.6] text-dim">
          Plugins ask for accounts when they need them, and you approve once.
          Revoking makes the next request ask again.
        </p>
        {authSessions.length === 0 ? (
          <div
            data-testid="plugin-auth-empty"
            className="rounded-xl border border-line px-4 py-3 text-[12px] text-dim"
          >
            No plugin has been granted access to an account.
          </div>
        ) : (
          <SettingsCard>
            {authSessions.map((granted) => (
              <div
                key={`${granted.pluginId}:${granted.providerId}`}
                data-testid={`plugin-auth-${granted.pluginId}-${granted.providerId}`}
              >
                <SettingsRow
                  label={
                    <span className="flex items-baseline gap-2">
                      <span className="truncate font-mono text-[12px]">{granted.pluginId}</span>
                      <span className="text-[11.5px] font-normal text-dim">→ {granted.providerId}</span>
                      {granted.account && (
                        <span className="text-[11.5px] font-normal text-text-body">
                          as {granted.account}
                        </span>
                      )}
                    </span>
                  }
                  help={
                    <span className="font-mono text-[11px]">
                      {granted.scopes.length > 0 ? granted.scopes.join(", ") : "no scopes"}
                    </span>
                  }
                  control={
                    onRevokeAuth ? (
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => void onRevokeAuth(granted.pluginId, granted.providerId)}
                      >
                        Revoke
                      </Button>
                    ) : null
                  }
                />
              </div>
            ))}
          </SettingsCard>
        )}
      </div>
    </div>
  )
}
