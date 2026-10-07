import { clipboard, Menu, type BrowserWindow, type MenuItemConstructorOptions } from "electron"

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
    if (params.linkURL) {
      if (items.length > 0) items.push({ type: "separator" })
      items.push({ label: "Copy Link Address", click: () => clipboard.writeText(params.linkURL) })
    }
    if (items.length === 0) return
    Menu.buildFromTemplate(items).popup({ window, frame: params.frame ?? undefined })
  })
}
