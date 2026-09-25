/** jsdom gaps used by cmdk-backed composer and global command surfaces. */
if (typeof Element !== "undefined") Element.prototype.scrollIntoView ??= () => {}
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
