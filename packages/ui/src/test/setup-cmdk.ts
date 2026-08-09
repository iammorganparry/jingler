/** jsdom gaps used by cmdk-backed composer and global command surfaces. */
Element.prototype.scrollIntoView ??= () => {}
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
