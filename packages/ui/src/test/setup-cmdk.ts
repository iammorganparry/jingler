/** jsdom gaps used by cmdk-backed composer and global command surfaces. */
if (typeof Element !== "undefined") Element.prototype.scrollIntoView ??= () => {}
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// jsdom's default 1024px window is under the 1100px chat-drawer breakpoint; tests assume a desktop window.
if (typeof window !== "undefined") window.innerWidth = 1280
