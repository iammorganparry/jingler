/**
 * Settings › Plugins — the front door for folder-drop installs.
 *
 * ## What this screen is for
 *
 * Plugins arrive by being copied into `~/starbase/plugins`, which means the
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
import {
  AlertTriangle,
  Boxes,
  FolderOpen,
  KeyRound,
  Plus,
  Trash2
} from "lucide-react"
import type { AuthSessionInfo, LoadedPlugin, PluginCatalog } from "@starbase/core"
import { cn } from "../lib/cn.js"
import { Badge } from "../components/badge.js"
import { Toggle } from "../components/toggle.js"

export interface PluginsSettingsProps {
  /** Everything under `~/starbase/plugins`, including what failed to decode. */
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
  /**
   * Why the operator's last action failed, if it did.
   *
   * Every callback below returns a promise, and this component invokes them as
   * `void onX()` — a rejection with nowhere to go became an unhandled promise
   * rejection visible only in devtools. The install flow made that plainly wrong:
   * the two commonest outcomes of choosing a folder are "no
   * `starbase.plugin.json` in the selected folder" and "already installed,
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

function Row({
  plugin,
  loadError,
  onSetEnabled,
  onUninstall,
  onReveal
}: {
  plugin: LoadedPlugin
  loadError?: string
  onSetEnabled: PluginsSettingsProps["onSetEnabled"]
  onUninstall: PluginsSettingsProps["onUninstall"]
  onReveal: PluginsSettingsProps["onReveal"]
}) {
  const [confirming, setConfirming] = useState(false)
  const { manifest } = plugin
  const broken = loadError ?? plugin.activationError

  return (
    <li
      data-testid={`plugin-row-${manifest.id}`}
      className="flex flex-col gap-2 border-b border-hairline px-3 py-3 last:border-b-0"
    >
      <div className="flex items-start gap-3">
        <Boxes
          size={16}
          className={cn("mt-0.5 flex-none", plugin.enabled ? "text-blue" : "text-line")}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[13px] font-medium text-text">
              {manifest.name}
            </span>
            <span className="flex-none font-mono text-[11px] text-dim">
              {manifest.version}
            </span>
            {plugin.builtin && (
              <Badge tone="count" size="xs">
                built-in
              </Badge>
            )}
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-dim">
            {manifest.id}
          </div>
          {manifest.description && (
            <p className="mt-1 text-[12px] leading-[1.5] text-text-body">
              {manifest.description}
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-dim">
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
        </div>

        <div className="flex flex-none items-center gap-2">
          <Toggle
            checked={plugin.enabled}
            onCheckedChange={(next: boolean) => void onSetEnabled(manifest.id, next)}
            aria-label={`Enable ${manifest.name}`}
          />
        </div>
      </div>

      {broken && (
        <div
          data-testid={`plugin-error-detail-${manifest.id}`}
          className="ml-7 flex items-start gap-2 rounded border border-yellow/40 bg-panel px-2.5 py-2"
        >
          <AlertTriangle size={13} className="mt-0.5 flex-none text-yellow" />
          {/* The decoder's own message, verbatim. A friendlier summary would
              throw away the line number that makes it fixable. */}
          <span className="font-mono text-[11px] leading-[1.5] text-text-body">
            {broken}
          </span>
        </div>
      )}

      <div className="ml-7 flex items-center gap-3 text-[11.5px]">
        <button
          type="button"
          onClick={() => void onReveal(manifest.id)}
          className="flex items-center gap-1 text-dim transition-colors hover:text-text-bright"
        >
          <FolderOpen size={12} /> Reveal
        </button>
        {!plugin.builtin &&
          (confirming ? (
            <span className="flex items-center gap-2">
              <span className="text-text-body">Remove this plugin&rsquo;s folder?</span>
              <button
                type="button"
                data-testid={`plugin-uninstall-confirm-${manifest.id}`}
                onClick={() => void onUninstall(manifest.id)}
                className="text-red transition-colors hover:text-text-bright"
              >
                Delete
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="text-dim transition-colors hover:text-text-bright"
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              data-testid={`plugin-uninstall-${manifest.id}`}
              onClick={() => setConfirming(true)}
              className="flex items-center gap-1 text-dim transition-colors hover:text-red"
            >
              <Trash2 size={12} /> Uninstall
            </button>
          ))}
      </div>
    </li>
  )
}

export function PluginsSettings({
  catalog,
  loadErrors = [],
  actionError = null,
  onDismissActionError,
  onSetEnabled,
  onUninstall,
  onReveal,
  onInstallFromFolder,
  authSessions = [],
  onRevokeAuth
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
            <code className="font-mono text-text-body">~/starbase/plugins</code> and it
            appears here — no restart.{" "}
            <span className="text-text-body">
              Plugins run with the same access as Starbase itself; install ones you
              trust.
            </span>
          </p>
        </div>
        {onInstallFromFolder && (
          <button
            type="button"
            data-testid="plugin-install-folder"
            onClick={() => void onInstallFromFolder()}
            className="flex flex-none items-center gap-1.5 rounded border border-line px-2.5 py-1.5 text-[12px] text-text-body transition-colors hover:border-blue hover:text-text-bright"
          >
            <Plus size={13} /> Install from folder…
          </button>
        )}
      </div>

      {/* Directly under the Install button, because that is the control whose
          failures the operator most needs explained and the one they were just
          looking at. */}
      {actionError !== null && (
        <div
          data-testid="plugin-action-error"
          role="alert"
          className="flex items-start gap-2 rounded border border-red/50 bg-panel px-3 py-2.5"
        >
          <AlertTriangle size={14} className="mt-0.5 flex-none text-red" />
          <span className="flex-1 text-[12.5px] leading-[1.6] text-text-body">
            {actionError}
          </span>
          {onDismissActionError && (
            <button
              type="button"
              data-testid="plugin-action-error-dismiss"
              onClick={onDismissActionError}
              className="flex-none text-[11.5px] text-dim transition-colors hover:text-text-bright"
            >
              Dismiss
            </button>
          )}
        </div>
      )}

      {plugins.length === 0 && undecodable.length === 0 ? (
        <div
          data-testid="plugins-empty"
          className="rounded border border-dashed border-line px-4 py-8 text-center"
        >
          <Boxes size={28} className="mx-auto text-line" strokeWidth={1.5} />
          <div className="mt-2 text-[13px] text-text">No plugins installed</div>
          <div className="mt-1 text-[12px] text-dim">
            Copy a plugin folder into{" "}
            <code className="font-mono">~/starbase/plugins</code> to get started.
          </div>
        </div>
      ) : (
        <ul className="overflow-hidden rounded border border-line bg-sunken">
          {plugins.map((plugin) => (
            <Row
              key={plugin.manifest.id}
              plugin={plugin}
              loadError={errorFor.get(plugin.manifest.id)}
              onSetEnabled={onSetEnabled}
              onUninstall={onUninstall}
              onReveal={onReveal}
            />
          ))}
        </ul>
      )}

      {undecodable.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-[13px] font-medium text-text">Could not be read</h3>
          <p className="text-[12px] text-dim">
            These folders are in your plugins directory but their{" "}
            <code className="font-mono">starbase.plugin.json</code> could not be
            decoded, so they contribute nothing.
          </p>
          <ul
            data-testid="plugins-undecodable"
            className="flex flex-col gap-px overflow-hidden rounded border border-line"
          >
            {undecodable.map((failure) => (
              <li key={failure.dir} className="bg-panel px-3 py-2">
                <div className="flex items-center gap-2">
                  <AlertTriangle size={13} className="flex-none text-yellow" />
                  <span className="font-mono text-[12px] text-text">{failure.dir}</span>
                  <Badge tone="count" size="xs">
                    {failure.kind}
                  </Badge>
                </div>
                <div className="mt-1 pl-5 font-mono text-[11px] leading-[1.5] text-dim">
                  {failure.message}
                </div>
              </li>
            ))}
          </ul>
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
            className="rounded border border-line bg-panel px-3 py-2.5 text-[12px] text-dim"
          >
            No plugin has been granted access to an account.
          </div>
        ) : (
          <ul className="flex flex-col gap-px overflow-hidden rounded border border-line">
            {authSessions.map((granted) => (
              <li
                key={`${granted.pluginId}:${granted.providerId}`}
                data-testid={`plugin-auth-${granted.pluginId}-${granted.providerId}`}
                className="flex items-center gap-3 bg-panel px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate font-mono text-[12px] text-text">
                      {granted.pluginId}
                    </span>
                    <span className="text-[11.5px] text-dim">→ {granted.providerId}</span>
                    {granted.account && (
                      <span className="text-[11.5px] text-text-body">
                        as {granted.account}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-dim">
                    {granted.scopes.length > 0 ? granted.scopes.join(", ") : "no scopes"}
                  </div>
                </div>
                {onRevokeAuth && (
                  <button
                    type="button"
                    onClick={() => void onRevokeAuth(granted.pluginId, granted.providerId)}
                    className="flex-none text-[11.5px] text-dim transition-colors hover:text-red"
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
