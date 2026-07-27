/**
 * Asking the operator whether a plugin may use an account.
 *
 * ## Why this is a NATIVE dialog and not an in-app one
 *
 * Every other modal in Jingler is React, and this one deliberately is not.
 * Plugin UI runs in the renderer's own realm — it can draw anything the app can
 * draw. A consent prompt rendered in that realm is a prompt a plugin could
 * obscure, mimic, or race, and the whole value of the prompt is that the
 * operator can believe what it says.
 *
 * A native modal is owned by main, is drawn by the OS, and cannot be touched by
 * anything in the renderer. For the one decision in the app that is purely about
 * trust, that is worth more than visual consistency.
 *
 * ## Why the scopes are listed, not summarised
 *
 * "Access your GitHub account" is the phrasing that trained a generation to
 * click Allow without reading. The provider, the plugin's real id, and the exact
 * scopes are all shown, because the operator is being asked to make a specific
 * decision and can only do that if they are told the specific thing.
 */
import { dialog, BrowserWindow } from "electron"
import type { ConsentPrompt } from "@jingler/cli-adapters"

export const nativeConsentPrompt: ConsentPrompt = async (request) => {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]

  const scopeList =
    request.scopes.length > 0
      ? request.scopes.map((scope) => `  • ${scope}`).join("\n")
      : "  • (no specific scopes)"

  const options = {
    type: "question" as const,
    // "Allow" is not the default button. The default is what an operator hits by
    // reflex when a modal appears over the thing they were doing, and reflex is
    // the opposite of consent.
    buttons: ["Allow", "Deny"],
    defaultId: 1,
    cancelId: 1,
    title: "Plugin access request",
    message: `“${request.pluginName}” wants to use your ${request.providerLabel} account`,
    detail: [
      `Plugin: ${request.pluginId}`,
      `Provider: ${request.providerId}`,
      "",
      "Requested access:",
      scopeList,
      "",
      "The plugin will be able to act as you, with this access, until you revoke it in Settings › Plugins.",
      "Only allow this if you trust the plugin."
    ].join("\n"),
    noLink: true
  }

  const result = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options)

  return result.response === 0
}
