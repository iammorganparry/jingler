import { clipboard, Menu, type BrowserWindow, type MenuItemConstructorOptions } from "electron"

function shouldCopyLinkAddress(linkURL: string, rendererURL: string): boolean {
  const link = URL.parse(linkURL)
  const renderer = URL.parse(rendererURL)
  // Worktree links resolve against the app document, not the worktree: file URLs in the built app,
  // or the renderer origin in development. Don't copy that misleading address.
  const rendererLocal = link?.protocol === "file:" || (link?.origin !== "null" && link?.origin === renderer?.origin)
  return link !== null && !rendererLocal
}

export function registerTextContextMenu(window: BrowserWindow): void {
  // Renderer contextmenu handlers that preventDefault never reach this event.
  window.webContents.on("context-menu", (event, params) => {
    if (event.defaultPrevented) return
    const items: MenuItemConstructorOptions[] = []
    if (params.isEditable) {
      items.push(
        { role: "cut", enabled: params.editFlags.canCut },
        { role: "copy", enabled: params.editFlags.canCopy },
        { role: "paste", enabled: params.editFlags.canPaste },
        { role: "selectAll", enabled: params.editFlags.canSelectAll }
      )
    } else if (params.selectionText.length > 0) {
      items.push({ role: "copy", enabled: params.editFlags.canCopy })
    }
    if (shouldCopyLinkAddress(params.linkURL, window.webContents.getURL())) {
      if (items.length > 0) items.push({ type: "separator" })
      items.push({ label: "Copy Link Address", click: () => clipboard.writeText(params.linkURL) })
    }
    if (items.length === 0) return
    Menu.buildFromTemplate(items).popup({ window, frame: params.frame ?? undefined })
  })
}
