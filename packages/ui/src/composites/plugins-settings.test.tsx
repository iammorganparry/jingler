import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { CircleDot } from "lucide-react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { LoadedPlugin, PluginCatalog } from "@jingler/core"
import { PluginsSettings } from "./plugins-settings.js"

afterEach(cleanup)

const plugin = (over: Partial<LoadedPlugin> = {}): LoadedPlugin =>
  ({
    manifest: {
      id: "hello-tab",
      name: "Hello Tab",
      version: "1.0.0",
      description: "The smallest complete plugin.",
      ui: "dist/ui.js",
      contributes: { tabs: [{ id: "hello-tab.greeting", label: "Hello" }] }
    },
    dir: "/home/dev/jingler/plugins/hello-tab",
    enabled: true,
    activated: false,
    builtin: false,
    ...over
  }) as LoadedPlugin

const catalog = (over: Partial<PluginCatalog> = {}): PluginCatalog =>
  ({ plugins: [plugin()], failed: [], ...over }) as PluginCatalog

const noop = () => {}
const base = { onSetEnabled: noop, onUninstall: noop, onReveal: noop }

describe("PluginsSettings", () => {
  it("lists an installed plugin with its id and version", () => {
    render(<PluginsSettings catalog={catalog()} {...base} />)
    expect(screen.getByTestId("plugin-row-hello-tab")).toBeTruthy()
    expect(screen.getByText("Hello Tab")).toBeTruthy()
    expect(screen.getByText("1.0.0")).toBeTruthy()
  })

  it("uses the renderer-resolved plugin mark in its configuration row", () => {
    render(
      <PluginsSettings
        catalog={catalog()}
        pluginIcons={{ "hello-tab": CircleDot }}
        {...base}
      />
    )
    expect(document.querySelector(".lucide-circle-dot")).toBeTruthy()
  })

  it("says plainly when a plugin runs no background process", () => {
    // "Does this run code?" is the question an operator actually has about an
    // installed plugin, and a manifest with no activationEvents never starts one.
    render(<PluginsSettings catalog={catalog()} {...base} />)
    expect(screen.getByText("no background process")).toBeTruthy()
  })

  it("names the activation events when a plugin does have a host half", () => {
    const withHost = plugin({
      manifest: {
        ...plugin().manifest,
        activationEvents: ["onTab:hello-tab.greeting"]
      }
    } as Partial<LoadedPlugin>)
    render(<PluginsSettings catalog={{ plugins: [withHost], failed: [] }} {...base} />)
    expect(screen.getByText(/onTab:hello-tab.greeting/)).toBeTruthy()
  })

  it("shows an empty state rather than an empty box", () => {
    render(<PluginsSettings catalog={{ plugins: [], failed: [] }} {...base} />)
    expect(screen.getByTestId("plugins-empty")).toBeTruthy()
    expect(screen.getByText("No plugins installed")).toBeTruthy()
  })

  it("shows a module load error against the plugin, verbatim", () => {
    // A friendlier summary would throw away the detail that makes it fixable.
    render(
      <PluginsSettings
        catalog={catalog()}
        loadErrors={[{ id: "hello-tab", message: "could not load dist/ui.js: Unexpected token" }]}
        {...base}
      />
    )
    const detail = screen.getByTestId("plugin-error-detail-hello-tab")
    expect(detail.textContent).toContain("Unexpected token")
    expect(detail.textContent).toContain("dist/ui.js")
  })

  it("lists a folder whose manifest would not decode, with the decoder's message", () => {
    // Without this the operator cannot tell "I installed it wrong" from "it
    // isn't installed" — both look like a missing tab.
    render(
      <PluginsSettings
        catalog={{
          plugins: [],
          failed: [
            {
              dir: "broken-plugin",
              kind: "manifest-invalid",
              message: 'activationEvents: unknown event "onStartup"'
            }
          ]
        }}
        {...base}
      />
    )
    const list = screen.getByTestId("plugins-undecodable")
    expect(list.textContent).toContain("broken-plugin")
    expect(list.textContent).toContain("onStartup")
    expect(list.textContent).toContain("manifest-invalid")
  })

  it("toggles a plugin through onSetEnabled", () => {
    const onSetEnabled = vi.fn()
    render(<PluginsSettings catalog={catalog()} {...base} onSetEnabled={onSetEnabled} />)
    fireEvent.click(screen.getByLabelText("Enable Hello Tab"))
    expect(onSetEnabled).toHaveBeenCalledWith("hello-tab", false)
  })

  it("confirms before uninstalling, because it deletes a folder", () => {
    const onUninstall = vi.fn()
    render(<PluginsSettings catalog={catalog()} {...base} onUninstall={onUninstall} />)

    fireEvent.click(screen.getByTestId("plugin-uninstall-hello-tab"))
    expect(onUninstall).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId("plugin-uninstall-confirm-hello-tab"))
    expect(onUninstall).toHaveBeenCalledWith("hello-tab")
  })

  it("offers no uninstall for a built-in plugin", () => {
    render(
      <PluginsSettings
        catalog={{ plugins: [plugin({ builtin: true })], failed: [] }}
        {...base}
      />
    )
    expect(screen.queryByTestId("plugin-uninstall-hello-tab")).toBeNull()
    expect(screen.getByText("built-in")).toBeTruthy()
  })

  it("states the trust model on the screen where plugins are installed", () => {
    // The one place an operator is deciding whether to trust a folder.
    render(<PluginsSettings catalog={catalog()} {...base} />)
    expect(screen.getByText(/same access as Jingler itself/)).toBeTruthy()
  })

  it("renders an unconfigured secret as an empty password field and saves it write-only", async () => {
    const onSetSecret = vi.fn(async () => undefined)
    const withSecret = plugin({
      manifest: {
        ...plugin().manifest,
        contributes: {
          settings: [
            {
              id: "hello-tab.api-key",
              label: "Personal API key",
              type: "secret",
              placeholder: "lin_api_…",
              documentationUrl: "https://linear.app/settings/api"
            }
          ]
        }
      }
    } as Partial<LoadedPlugin>)

    render(
      <PluginsSettings
        catalog={{ plugins: [withSecret], failed: [] }}
        {...base}
        settings={{
          "hello-tab": { values: {}, secrets: { "hello-tab.api-key": false } }
        }}
        onSetSecret={onSetSecret}
        onClearSecret={async () => undefined}
      />
    )

    const input = screen.getByLabelText("Personal API key") as HTMLInputElement
    expect(input.type).toBe("password")
    expect(input.value).toBe("")
    expect(input.placeholder).toBe("lin_api_…")

    fireEvent.change(input, { target: { value: "lin_api_new" } })
    fireEvent.click(screen.getByText("Save"))
    await waitFor(() =>
      expect(onSetSecret).toHaveBeenCalledWith(
        "hello-tab",
        "hello-tab.api-key",
        "lin_api_new"
      )
    )
  })

  it("shows only masked configured state, then offers Replace and Remove", async () => {
    const onSetSecret = vi.fn(async () => undefined)
    const onClearSecret = vi.fn(async () => undefined)
    const withSecret = plugin({
      manifest: {
        ...plugin().manifest,
        contributes: {
          settings: [
            {
              id: "hello-tab.api-key",
              label: "Personal API key",
              type: "secret",
              description: "Stored securely."
            }
          ]
        }
      }
    } as Partial<LoadedPlugin>)

    const { container } = render(
      <PluginsSettings
        catalog={{ plugins: [withSecret], failed: [] }}
        {...base}
        settings={{
          "hello-tab": { values: {}, secrets: { "hello-tab.api-key": true } }
        }}
        onSetSecret={onSetSecret}
        onClearSecret={onClearSecret}
      />
    )

    const masked = screen.getByLabelText("Personal API key") as HTMLInputElement
    expect(masked.type).toBe("password")
    expect(masked.value).toBe("configured")
    expect(container.textContent).not.toContain("lin_api_saved")
    expect(screen.getByText("Replace")).toBeTruthy()
    expect(screen.getByText("Remove")).toBeTruthy()

    fireEvent.click(screen.getByText("Replace"))
    const replacement = screen.getByLabelText("Personal API key") as HTMLInputElement
    expect(replacement.value).toBe("")
    fireEvent.change(replacement, { target: { value: "replacement" } })
    fireEvent.click(screen.getByText("Save"))
    await waitFor(() =>
      expect(onSetSecret).toHaveBeenCalledWith(
        "hello-tab",
        "hello-tab.api-key",
        "replacement"
      )
    )

    fireEvent.click(screen.getByText("Remove"))
    expect(onClearSecret).toHaveBeenCalledWith("hello-tab", "hello-tab.api-key")
  })

  it("renders and saves an ordinary manifest-declared setting", () => {
    const onSetSetting = vi.fn(async () => undefined)
    const withSetting = plugin({
      manifest: {
        ...plugin().manifest,
        contributes: {
          settings: [
            {
              id: "hello-tab.team",
              label: "Team",
              type: "string"
            }
          ]
        }
      }
    } as Partial<LoadedPlugin>)

    render(
      <PluginsSettings
        catalog={{ plugins: [withSetting], failed: [] }}
        {...base}
        settings={{
          "hello-tab": { values: { "hello-tab.team": "Platform" }, secrets: {} }
        }}
        onSetSetting={onSetSetting}
      />
    )

    const input = screen.getByLabelText("Team") as HTMLInputElement
    expect(input.value).toBe("Platform")
    fireEvent.change(input, { target: { value: "Product" } })
    fireEvent.click(screen.getByText("Save"))
    expect(onSetSetting).toHaveBeenCalledWith(
      "hello-tab",
      "hello-tab.team",
      "Product"
    )
  })
})

describe("granted access", () => {
  it("says so when no plugin holds credentials", () => {
    render(<PluginsSettings catalog={catalog()} {...base} />)
    expect(screen.getByTestId("plugin-auth-empty")).toBeTruthy()
  })

  it("lists a grant by plugin, provider, account and scopes", () => {
    render(
      <PluginsSettings
        catalog={catalog()}
        {...base}
        authSessions={[
          {
            pluginId: "hello-tab",
            providerId: "github",
            account: "octocat",
            scopes: ["repo", "read:org"],
            grantedAt: "2026-07-25T10:00:00.000Z"
          }
        ]}
      />
    )
    const row = screen.getByTestId("plugin-auth-hello-tab-github")
    expect(row.textContent).toContain("hello-tab")
    expect(row.textContent).toContain("github")
    expect(row.textContent).toContain("octocat")
    expect(row.textContent).toContain("repo, read:org")
  })

  it("never renders a token, only metadata", () => {
    // `AuthSessionInfo` has no token field; this asserts the screen cannot start
    // showing one by accident if that ever changes.
    const { container } = render(
      <PluginsSettings
        catalog={catalog()}
        {...base}
        authSessions={[
          {
            pluginId: "hello-tab",
            providerId: "github",
            scopes: ["repo"],
            grantedAt: "2026-07-25T10:00:00.000Z",
            // @ts-expect-error deliberately passing a field the schema forbids
            accessToken: "ghp_secret"
          }
        ]}
      />
    )
    expect(container.textContent).not.toContain("ghp_secret")
  })

  it("revokes a grant", () => {
    const onRevokeAuth = vi.fn()
    render(
      <PluginsSettings
        catalog={catalog()}
        {...base}
        onRevokeAuth={onRevokeAuth}
        authSessions={[
          {
            pluginId: "hello-tab",
            providerId: "github",
            scopes: ["repo"],
            grantedAt: "2026-07-25T10:00:00.000Z"
          }
        ]}
      />
    )
    fireEvent.click(screen.getByText("Revoke"))
    expect(onRevokeAuth).toHaveBeenCalledWith("hello-tab", "github")
  })
})
