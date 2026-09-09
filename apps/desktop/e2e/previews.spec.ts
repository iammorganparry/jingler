import { createServer, type Server } from "node:http"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, sessionRow, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * Rich in-chat previews, end to end against the built app. A persisted transcript
 * carries LaTeX + a fenced html block, so the assertions cover what the operator
 * actually sees:
 *  - `$…$` / `$$…$$` render as KaTeX (a `.katex` node), not raw dollar-math;
 *  - an html block defaults to the plain-text Code view and, on opt-in, renders a
 *    sandboxed Preview iframe;
 *  - the session-owned Browser opens as a tab beside the current chat.
 *
 * The browser preview is a native `WebContentsView` (out of the DOM, like the
 * xterm canvas in terminal.spec.ts), so we assert on the pane's React chrome
 * (the address bar), never on the loaded page's pixels.
 */

const RICH_MARKDOWN = [
  "Inline math $E = mc^2$ and a display equation:",
  "",
  "$$\\int_0^1 x^2\\,dx = \\tfrac{1}{3}$$",
  "",
  "And some HTML:",
  "",
  "```html",
  "<h1>Hello preview</h1>",
  "```",
  ""
].join("\n")

const seededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_seeded",
    repo: "widget",
    branch: "chore/refactor",
    title: "Refactor auth flow",
    status: "idle",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-11T00:00:00.000Z",
    worktreePath: repoPath,
    mode: "accept-edits"
  }
]

const isolatedSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    ...seededSessions({ repoPath })[0]!,
    id: "s_preview_alpha",
    branch: "jingler/preview-alpha",
    title: "Preview Alpha"
  },
  {
    ...seededSessions({ repoPath })[0]!,
    id: "s_preview_beta",
    branch: "jingler/preview-beta",
    title: "Preview Beta"
  }
]

const agentBrowserSession = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [{
  ...seededSessions({ repoPath })[0]!,
  id: "s_preview_agents",
  title: "Agent browser isolation",
  chats: [
    { id: "chat-alpha", title: "Agent Alpha", createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" },
    { id: "chat-beta", title: "Agent Beta", createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" }
  ],
  activeChatId: "chat-alpha"
}]

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })

test("renders LaTeX + an opt-in HTML preview, and drives the browser pane", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    sessions: seededSessions,
    transcripts: {
      s_seeded: [
        {
          id: "a_rich",
          role: "assistant",
          streaming: false,
          createdAt: "2026-07-11T00:00:00.000Z",
          parts: [{ _tag: "Text", text: RICH_MARKDOWN }]
        }
      ]
    }
  })

  await expect(appShell(window)).toBeVisible()
  await window.setViewportSize({ width: 1500, height: 860 })

  // LaTeX: KaTeX mounts a `.katex` node — the raw "$E = mc^2$" is never shown.
  await expect(window.locator(".katex").first()).toBeVisible({ timeout: 10_000 })

  // HTML block defaults to the Code view (transcript stays plain text).
  const preview = window.getByRole("tab", { name: /Preview/ })
  await expect(window.getByRole("tab", { name: /Code/ })).toBeVisible()
  await expect(window.locator('iframe[title="HTML preview"]')).toHaveCount(0)

  // Opting into Preview mounts the sandboxed iframe.
  await preview.click()
  await expect(window.locator('iframe[title="HTML preview"]')).toBeVisible()

  // A newly opened Browser stacks beside the current chat while both remain readable.
  await window.getByTestId("view-tab-browser").click()
  const url = window.getByLabel("Preview URL").filter({ visible: true }).first()
  await expect(url).toBeVisible()
  await expect(window.getByTestId("open-view-tab-browser")).toBeVisible()
  await expect(window.getByTestId("surface-view")).toHaveAttribute("data-panes", "2")
  await expect(window.locator(".katex").first()).toBeVisible()
  await url.fill("http://localhost:4321")
  await url.press("Enter")
  await expect(url).toBeVisible()

})

test("browser sign-in popups keep their opener without app privileges", async ({ launchApp }) => {
  let unsafeRedirectRequested = false
  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      unsafeRedirectRequested = true
      response.writeHead(302, { Location: "file:///etc/passwd" })
      response.end()
      return
    }
    response.writeHead(200, { "Content-Type": "text/html" })
    if (request.url === "/popup") {
      response.end(
        `<script>` +
          `const nested = window.open('/nested');` +
          `window.opener.postMessage({` +
          `cookie: document.cookie,` +
          `requireType: typeof require,` +
          `jinglerType: typeof window.jingler,` +
          `nestedBlocked: nested === null` +
          `}, location.origin);` +
          `setTimeout(() => window.close(), 100);` +
          `</script>`
      )
      return
    }
    response.end(
      `<body><button id="sign-in">Sign in</button><button id="unsafe">Unsafe redirect</button>` +
        `<script>` +
        `document.cookie='owner=browser; path=/';` +
        `addEventListener('message', event => { document.body.dataset.result = JSON.stringify(event.data); });` +
        `document.querySelector('#sign-in').onclick = () => {` +
        `const popup = window.open('about:blank', 'oauth', 'width=480,height=640');` +
        `popup.location.href = '/popup';` +
        `};` +
        `document.querySelector('#unsafe').onclick = () => window.open('/redirect', 'unsafe');` +
        `</script></body>`
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen({ host: "127.0.0.1", port: 0 }, resolve)
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    await closeServer(server)
    throw new Error("Preview popup server has no TCP address")
  }
  const origin = `http://127.0.0.1:${address.port}`

  try {
    const { app, window } = await launchApp({
      configured: true,
      isolateSystemHome: true,
      withRepo: true,
      sessions: seededSessions
    })
    await expect(appShell(window)).toBeVisible()
    await window.getByTestId("view-tab-browser").click()
    const url = window.getByLabel("Preview URL").filter({ visible: true }).first()
    await url.fill(`${origin}/opener`)
    await url.press("Enter")
    await expect.poll(() => app.evaluate(
      ({ webContents }, expectedUrl) =>
        webContents.getAllWebContents().some((contents) => contents.getURL() === expectedUrl),
      `${origin}/opener`
    )).toBe(true)

    await app.evaluate(async ({ webContents }, expectedUrl) => {
      const opener = webContents.getAllWebContents().find((contents) => contents.getURL() === expectedUrl)
      await opener?.executeJavaScript(`document.querySelector('#sign-in').click()`)
    }, `${origin}/opener`)

    await expect.poll(() => app.evaluate(async ({ webContents }, expectedUrl) => {
      const opener = webContents.getAllWebContents().find((contents) => contents.getURL() === expectedUrl)
      return opener?.executeJavaScript("document.body.dataset.result ?? ''")
    }, `${origin}/opener`)).toBe(
      JSON.stringify({
        cookie: "owner=browser",
        requireType: "undefined",
        jinglerType: "undefined",
        nestedBlocked: true
      })
    )

    await app.evaluate(async ({ webContents }, expectedUrl) => {
      const opener = webContents.getAllWebContents().find((contents) => contents.getURL() === expectedUrl)
      await opener?.executeJavaScript(`document.querySelector('#unsafe').click()`)
    }, `${origin}/opener`)
    await expect.poll(() => unsafeRedirectRequested).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(
      await app.evaluate(({ webContents }) =>
        webContents.getAllWebContents().some((contents) => contents.getURL() === "file:///etc/passwd")
      )
    ).toBe(false)
  } finally {
    await closeServer(server)
  }
})

test("restores each session's URL, history, scroll, visibility, and cookies", async ({
  launchApp
}) => {
  const server = createServer((request, response) => {
    const owner = (request.url ?? "").includes("beta") ? "beta" : "alpha"
    response.writeHead(200, { "Content-Type": "text/html" })
    response.end(
      `<!doctype html><title>${owner}</title>` +
        `<body style="height:4000px"><h1>${owner}</h1>` +
        `<script>document.cookie="owner=${owner}; path=/";` +
        `setTimeout(() => { history.pushState({}, "", "/${owner}-history"); scrollTo(0, ${owner === "alpha" ? 640 : 920}); }, 100)</script>`
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen({ host: "127.0.0.1", port: 0 }, resolve)
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    await closeServer(server)
    throw new Error("Preview isolation server has no TCP address")
  }
  const origin = `http://127.0.0.1:${address.port}`

  try {
    const { app, window } = await launchApp({
      configured: true,
      isolateSystemHome: true,
      withRepo: true,
      sessions: isolatedSessions
    })
    await expect(appShell(window)).toBeVisible()
    await window.getByTestId("view-tab-browser").click()
    const url = window.getByLabel("Preview URL").filter({ visible: true }).first()
    await url.fill(`${origin}/alpha`)
    await url.press("Enter")
    await expect(url).toHaveValue(`${origin}/alpha-history`, { timeout: 10_000 })

    await sessionRow(window, "Preview Beta").click()
    await window.getByTestId("view-tab-browser").click()
    await url.fill(`${origin}/beta`)
    await url.press("Enter")
    await expect(url).toHaveValue(`${origin}/beta-history`, { timeout: 10_000 })

    const pages = await app.evaluate(async ({ webContents }, expectedOrigin) =>
      Promise.all(
        webContents
          .getAllWebContents()
          .filter((contents) => contents.getURL().startsWith(expectedOrigin))
          .map(async (contents) => ({
            url: contents.getURL(),
            cookie: await contents.executeJavaScript("document.cookie"),
            scrollY: await contents.executeJavaScript("window.scrollY"),
            historyLength: await contents.executeJavaScript("history.length")
          }))
      ), origin)
    expect(pages).toHaveLength(2)
    expect(pages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: `${origin}/alpha-history`,
          cookie: "owner=alpha",
          scrollY: 640
        }),
        expect.objectContaining({
          url: `${origin}/beta-history`,
          cookie: "owner=beta",
          scrollY: 920
        })
      ])
    )
    expect(pages.every((page) => page.historyLength >= 2)).toBe(true)

    // Open Browser surfaces are session state too. Focusing Chat does not close
    // the adjacent Browser pane, and switching sessions restores each pane.
    await window.getByRole("button", { name: "Chat 1", exact: true }).click()
    await expect(url).toHaveValue(`${origin}/beta-history`)
    await sessionRow(window, "Preview Alpha").click()
    await window.getByTestId("open-view-tab-browser").getByRole("button", { name: "Browser", exact: true }).click()
    await expect(url).toHaveValue(`${origin}/alpha-history`)
    await sessionRow(window, "Preview Beta").click()
    await expect(url).toHaveValue(`${origin}/beta-history`)

    await sessionRow(window, "Preview Alpha").click()
    await window.getByTestId("open-view-tab-browser").getByRole("button", { name: "Browser", exact: true }).click()
    await window.getByRole("button", { name: "Close Browser", exact: true }).click()
    await expect.poll(() => app.evaluate(
      ({ webContents }, expectedOrigin) =>
        webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith(expectedOrigin)).length,
      origin
    )).toBe(1)
  } finally {
    await closeServer(server)
  }
})

test("two agents in one session keep independent browser state", async ({ launchApp }) => {
  const server = createServer((request, response) => {
    const owner = request.url?.includes("beta") ? "beta" : "alpha"
    if (!request.url?.endsWith("-history")) {
      response.writeHead(200, { "Content-Type": "text/html" })
      response.end(`<script>document.cookie="owner=${owner}; path=/";localStorage.setItem("owner","${owner}");history.pushState({},"","/${owner}-history")</script>`)
      return
    }
    response.writeHead(200, { "Content-Type": "text/html" })
    response.end(owner)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen({ host: "127.0.0.1", port: 0 }, resolve)
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    await closeServer(server)
    throw new Error("Agent browser isolation server has no TCP address")
  }
  const origin = `http://127.0.0.1:${address.port}`

  try {
    const { app, window } = await launchApp({
      configured: true,
      isolateSystemHome: true,
      withRepo: true,
      sessions: agentBrowserSession
    })
    await expect(appShell(window)).toBeVisible()
    const focusedUrl = () => window
      .locator('[data-testid^="surface-pane-"][data-focused="true"]')
      .getByLabel("Preview URL")
    await window.getByTestId("view-tab-browser").click()
    await focusedUrl().fill(`${origin}/alpha`)
    await focusedUrl().press("Enter")
    await expect(focusedUrl()).toHaveValue(`${origin}/alpha-history`)

    await window.getByTitle("2. Agent Beta").click()
    await expect(focusedUrl()).toHaveCount(0)
    await window.getByTestId("view-tab-browser").click()
    await focusedUrl().fill(`${origin}/beta`)
    await focusedUrl().press("Enter")
    await expect(focusedUrl()).toHaveValue(`${origin}/beta-history`)

    const pages = await app.evaluate(async ({ webContents }, expectedOrigin) =>
      Promise.all(webContents.getAllWebContents()
        .filter((contents) => contents.getURL().startsWith(expectedOrigin))
        .map(async (contents) => ({
          url: contents.getURL(),
          cookie: await contents.executeJavaScript("document.cookie"),
          owner: await contents.executeJavaScript("localStorage.getItem('owner')"),
          historyLength: await contents.executeJavaScript("history.length")
        }))), origin)
    expect(pages).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: `${origin}/alpha-history`, cookie: "owner=alpha", owner: "alpha" }),
      expect.objectContaining({ url: `${origin}/beta-history`, cookie: "owner=beta", owner: "beta" })
    ]))
    expect(pages.every((page) => page.historyLength >= 2)).toBe(true)

    await window.getByTitle("1. Agent Alpha").click()
    await window.getByRole("button", { name: "Browser · Agent Alpha", exact: true }).click()
    await expect(focusedUrl()).toHaveValue(`${origin}/alpha-history`)
  } finally {
    await closeServer(server)
  }
})

test("deleting a session closes its native browser resources", async ({ launchApp }) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" })
    response.end(
      "<!doctype html><title>delete me</title><h1>Session browser resource</h1>" +
        '<script>document.cookie="delete_me=yes; path=/"; localStorage.setItem("delete_me", "yes")</script>'
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen({ host: "127.0.0.1", port: 0 }, resolve)
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    await closeServer(server)
    throw new Error("Preview cleanup server has no TCP address")
  }
  const origin = `http://127.0.0.1:${address.port}`

  try {
    const { app, window } = await launchApp({
      configured: true,
      isolateSystemHome: true,
      withRepo: true,
      sessions: isolatedSessions
    })
    await expect(appShell(window)).toBeVisible()
    await window.getByTestId("view-tab-browser").click()
    const url = window.getByLabel("Preview URL").filter({ visible: true }).first()
    await url.fill(`${origin}/owned-by-alpha`)
    await url.press("Enter")
    await expect(url).toHaveValue(`${origin}/owned-by-alpha`)

    const resourceCount = () =>
      app.evaluate(
        ({ webContents }, expectedOrigin) =>
          webContents
            .getAllWebContents()
            .filter((contents) => contents.getURL().startsWith(expectedOrigin)).length,
        origin
      )
    await expect.poll(resourceCount).toBe(1)
    const partition =
      "persist:jingler-browser-preview:s_preview_alpha:c_s_preview_alpha_1"
    await expect
      .poll(() =>
        app.evaluate(
          async ({ session }, name) =>
            (await session.fromPartition(name).cookies.get({ name: "delete_me" })).length,
          partition
        )
      )
      .toBe(1)

    const alphaRow = window.getByTestId("session-row-s_preview_alpha")
    await alphaRow.click({ button: "right" })
    await window.getByRole("menuitem", { name: "Delete" }).click()
    await window.getByRole("dialog").getByRole("button", { name: "Delete" }).click()

    await expect(alphaRow).toHaveCount(0)
    await expect.poll(resourceCount).toBe(0)
    await expect
      .poll(() =>
        app.evaluate(
          async ({ session }, name) =>
            (await session.fromPartition(name).cookies.get({ name: "delete_me" })).length,
          partition
        )
      )
      .toBe(0)
    await expect(sessionRow(window, "Preview Beta")).toBeVisible()
  } finally {
    await closeServer(server)
  }
})

test("retains each session browser while Files owns two split panes", async ({ launchApp }) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" })
    response.end("<!doctype html><title>coexist</title><h1>Preview stays alive</h1>")
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen({ host: "127.0.0.1", port: 0 }, resolve)
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    await closeServer(server)
    throw new Error("PDF coexistence server has no TCP address")
  }
  const origin = `http://127.0.0.1:${address.port}`

  try {
    const { app, window } = await launchApp({
      configured: true,
      isolateSystemHome: true,
      withRepo: true,
      sessions: isolatedSessions,
      seed: ({ repoPath }) => {
        writeFileSync(join(repoPath, "alpha.pdf"), "%PDF-1.4\n%%EOF\n")
        writeFileSync(join(repoPath, "beta.pdf"), "%PDF-1.4\n%%EOF\n")
      }
    })
    await expect(appShell(window)).toBeVisible()
    await window.getByTestId("view-tab-browser").click()
    const url = window.getByLabel("Preview URL").filter({ visible: true }).first()
    await url.fill(origin)
    await url.press("Enter")

    await window.keyboard.press("Control+Shift+Equal")
    const alphaPane = window.getByTestId("split-pane-0")
    const betaPane = window.getByTestId("split-pane-1")
    // The internet dock follows the focused session. Seed Beta's own browser
    // before opening its PDF so the final visible browser is Beta's retained
    // view, not Alpha's deliberately hidden one.
    await expect(betaPane).toHaveAttribute("data-focused", "true")
    await window.getByTestId("view-tab-browser").click()
    const betaUrl = betaPane.getByLabel("Preview URL")
    await betaUrl.fill(origin)
    await betaUrl.press("Enter")

    await alphaPane.getByTestId("surface-pane-toolbar-1").dispatchEvent("mousedown")
    await expect(alphaPane).toHaveAttribute("data-focused", "true")
    await window.keyboard.press("Meta+Shift+p")
    const picker = window.getByTestId("file-quick-open")
    await expect(picker).toBeVisible()
    await window.getByPlaceholder("Open a file in Preview Alpha…").fill("alpha.pdf")
    await window.getByTestId("palette-item-file:alpha.pdf").click()
    await expect(picker).toBeHidden()
    await expect(
      window.getByTestId("file-tab-alpha.pdf").getByRole("button", { name: "alpha.pdf", exact: true })
    ).toHaveAttribute("aria-current", "page")

    await betaPane.getByTestId("surface-pane-toolbar-1").dispatchEvent("mousedown")
    await expect(betaPane).toHaveAttribute("data-focused", "true")
    await window.keyboard.press("Meta+Shift+p")
    await expect(picker).toBeVisible()
    await window.getByPlaceholder("Open a file in Preview Beta…").fill("beta.pdf")
    await window.getByTestId("palette-item-file:beta.pdf").click()
    await expect(picker).toBeHidden()
    await expect(
      window.getByTestId("file-tab-beta.pdf").getByRole("button", { name: "beta.pdf", exact: true })
    ).toHaveAttribute("aria-current", "page")

    const visibleNativeUrls = () =>
      app.evaluate(({ BrowserWindow }, expectedOrigin) => {
        const root = BrowserWindow.getAllWindows()[0]?.contentView
        return (root?.children ?? [])
          .filter((view) => view.getVisible())
          .map((view) => {
            const candidate = view as typeof view & {
              webContents?: { getURL(): string }
            }
            return candidate.webContents?.getURL() ?? ""
          })
          .filter((loadedUrl) =>
            loadedUrl.startsWith(expectedOrigin) || loadedUrl.startsWith("file:")
          )
      }, origin)

    await expect
      .poll(() =>
        visibleNativeUrls()
      )
      .toEqual(
        expect.arrayContaining([
          expect.stringContaining("alpha.pdf"),
          expect.stringContaining("beta.pdf")
        ])
      )
    await alphaPane.getByTestId("surface-pane-toolbar-0").dispatchEvent("mousedown")
    await window.getByTestId("view-tab-browser").click()
    await expect(alphaPane.getByLabel("Preview URL")).toHaveValue(origin)

    await betaPane.getByTestId("surface-pane-toolbar-0").dispatchEvent("mousedown")
    await window.getByTestId("view-tab-browser").click()
    await expect(betaPane.getByLabel("Preview URL")).toHaveValue(origin)
    await expect.poll(async () => (await visibleNativeUrls()).some((url) => url.startsWith(origin))).toBe(true)

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.blur())
    await expect.poll(async () => (await visibleNativeUrls()).some((url) => url.startsWith(origin))).toBe(true)
  } finally {
    await closeServer(server)
  }
})
