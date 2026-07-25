import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * `starbase-plugin://` serves third-party code out of the operator's home
 * directory, so the interesting tests are all about what it REFUSES.
 *
 * Electron is stubbed rather than launched: `protocol.registerSchemesAsPrivileged`
 * and `protocol.handle` are the only surface used, and neither is what these
 * tests are about.
 */
vi.mock("electron", () => ({
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  app: { getPath: () => home }
}))

let home: string

// The module reads `STARBASE_HOME` through `app-paths`, which resolves it at
// import time — so the temp home has to exist before the dynamic import below.
const load = async () => await import("./plugin-protocol.js")

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "starbase-plugin-protocol-"))
  process.env.STARBASE_HOME = home
  vi.resetModules()
})

afterEach(async () => {
  delete process.env.STARBASE_HOME
  await rm(home, { recursive: true, force: true })
})

const pluginDir = (id: string) => join(home, "starbase", "plugins", id)

const writePlugin = async (id: string, files: Record<string, string>) => {
  const dir = pluginDir(id)
  await mkdir(dir, { recursive: true })
  for (const [name, body] of Object.entries(files)) {
    const file = join(dir, name)
    await mkdir(join(file, ".."), { recursive: true })
    await writeFile(file, body, "utf8")
  }
  return dir
}

describe("resolvePluginAsset", () => {
  it("resolves a file inside the plugin's own directory", async () => {
    const { resolvePluginAsset } = await load()
    await writePlugin("hello-tab", { "ui.js": "export default 1" })
    expect(await resolvePluginAsset("hello-tab", "/ui.js")).toContain("ui.js")
  })

  it("resolves a nested file, so a plugin can ship a real build output", async () => {
    const { resolvePluginAsset } = await load()
    await writePlugin("hello-tab", { "dist/ui.js": "export default 1" })
    expect(await resolvePluginAsset("hello-tab", "/dist/ui.js")).toContain("ui.js")
  })

  it.each([
    ["parent traversal", "/../../../etc/passwd"],
    ["encoded traversal", "/%2e%2e/%2e%2e/etc/passwd"],
    ["an absolute-looking path", "//etc/passwd"],
    ["an empty path", "/"]
  ])("refuses %s", async (_why, path) => {
    const { resolvePluginAsset } = await load()
    await writePlugin("hello-tab", { "ui.js": "export default 1" })
    expect(await resolvePluginAsset("hello-tab", path)).toBeNull()
  })

  it("refuses a symlink escaping the plugin directory", async () => {
    // The lexical check passes here — the LINK path is innocent. Only the
    // post-realpath check catches this, which is why both exist.
    const { resolvePluginAsset } = await load()
    const dir = await writePlugin("hello-tab", { "ui.js": "export default 1" })
    const secret = join(home, "secret.txt")
    await writeFile(secret, "ssh-rsa AAAA", "utf8")
    await symlink(secret, join(dir, "leak.txt"))

    expect(await resolvePluginAsset("hello-tab", "/leak.txt")).toBeNull()
  })

  it.each([
    ["an id with traversal", ".."],
    ["an id with a slash", "a/b"],
    ["an uppercase id", "HelloTab"],
    ["the reserved runtime host", "runtime"],
    ["an empty id", ""]
  ])("refuses %s", async (_why, id) => {
    const { resolvePluginAsset } = await load()
    expect(await resolvePluginAsset(id, "/ui.js")).toBeNull()
  })

  it("refuses a directory, which would otherwise be served as garbage bytes", async () => {
    const { resolvePluginAsset } = await load()
    await writePlugin("hello-tab", { "dist/ui.js": "export default 1" })
    expect(await resolvePluginAsset("hello-tab", "/dist")).toBeNull()
  })

  it("refuses a plugin that does not exist", async () => {
    const { resolvePluginAsset } = await load()
    expect(await resolvePluginAsset("absent", "/ui.js")).toBeNull()
  })
})

describe("handlePluginRequest", () => {
  it("serves a plugin module as JavaScript", async () => {
    const { handlePluginRequest } = await load()
    await writePlugin("hello-tab", { "ui.js": "export default 42" })

    const response = await handlePluginRequest("starbase-plugin://hello-tab/ui.js")
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/javascript")
    expect(await response.text()).toContain("42")
  })

  it("never caches a plugin file, so an author's edit shows up on reload", async () => {
    const { handlePluginRequest } = await load()
    await writePlugin("hello-tab", { "ui.js": "export default 1" })
    const response = await handlePluginRequest("starbase-plugin://hello-tab/ui.js")
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("404s a traversal attempt rather than distinguishing it from a miss", async () => {
    // A distinct "refused" status would let a plugin map the filesystem one
    // probe at a time.
    const { handlePluginRequest } = await load()
    const refused = await handlePluginRequest(
      "starbase-plugin://hello-tab/../../../etc/passwd"
    )
    const missing = await handlePluginRequest("starbase-plugin://hello-tab/nope.js")
    expect(refused.status).toBe(404)
    expect(missing.status).toBe(404)
  })

  it("serves the React shim off the reserved runtime host", async () => {
    const { handlePluginRequest } = await load()
    const response = await handlePluginRequest("starbase-plugin://runtime/react.js")
    expect(response.status).toBe(200)
    const source = await response.text()
    // The whole point: it re-exports the app's instance, it does not bundle one.
    expect(source).toContain("__STARBASE_RUNTIME__")
    expect(source).toContain("export const useState")
    expect(source).not.toContain("import ")
  })

  it("re-exports every SDK hook, derived from the real module rather than a list", async () => {
    // The regression this exists for: the shim's bindings were once hand-listed,
    // so adding an export to the SDK would compile, ship, and hand plugins
    // `undefined` for a function that plainly exists.
    const { handlePluginRequest } = await load()
    const Sdk = await import("@starbase/plugin-sdk")
    const source = await (
      await handlePluginRequest("starbase-plugin://runtime/sdk.js")
    ).text()

    for (const name of Object.keys(Sdk).filter((n) => n !== "default")) {
      expect(source, `${name} is re-exported`).toContain(`export const ${name} =`)
    }
    // And specifically the four hooks a plugin cannot work without.
    for (const hook of ["useHost", "useSession", "usePluginStorage", "useCommand"]) {
      expect(source).toContain(`export const ${hook} =`)
    }
  })

  it("re-exports the SDK's context, without which every plugin hook throws", async () => {
    // `PluginViewProvider` is how the app scopes the hooks to one view. If the
    // shim dropped it, a plugin's `useHost()` would read a context the app never
    // filled and report being outside a plugin view from inside one.
    const { handlePluginRequest } = await load()
    const source = await (
      await handlePluginRequest("starbase-plugin://runtime/sdk.js")
    ).text()
    expect(source).toContain("export const PluginViewContext =")
    expect(source).toContain("export const PluginViewProvider =")
  })

  it("emits only valid identifiers, so the shim parses as a module", async () => {
    const { handlePluginRequest } = await load()
    for (const mod of ["react.js", "jsx-runtime.js", "sdk.js"]) {
      const source = await (
        await handlePluginRequest(`starbase-plugin://runtime/${mod}`)
      ).text()
      // A namespace carries `default` and may carry `__esModule`; neither is
      // legal after `export const`, and one slipping through is a syntax error
      // that takes out every plugin at once.
      expect(source).not.toMatch(/export const (default|__esModule)\b/)
      for (const [, name] of source.matchAll(/export const ([^\s=]+) =/g)) {
        expect(name).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]*$/)
      }
    }
  })

  it("serves the jsx-runtime shim, which every compiled plugin component needs", async () => {
    const { handlePluginRequest } = await load()
    const response = await handlePluginRequest("starbase-plugin://runtime/jsx-runtime.js")
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("export const jsx")
  })

  it("throws a named error if a plugin module is imported before the runtime is published", async () => {
    const { handlePluginRequest } = await load()
    const source = await (
      await handlePluginRequest("starbase-plugin://runtime/react.js")
    ).text()
    // Better than `undefined is not an object` three frames into a plugin.
    expect(source).toContain("Starbase plugin runtime is not published yet")
  })

  it("404s an unknown runtime module instead of falling through to the filesystem", async () => {
    const { handlePluginRequest } = await load()
    const response = await handlePluginRequest("starbase-plugin://runtime/../ui.js")
    expect(response.status).toBe(404)
  })

  it("404s a malformed URL", async () => {
    const { handlePluginRequest } = await load()
    expect((await handlePluginRequest("not a url")).status).toBe(404)
  })
})
