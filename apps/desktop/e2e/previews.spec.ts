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
 *  - the browser-preview pane toggles open and its address bar drives navigation.
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
    cli: "claude",
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

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })

test("renders LaTeX + an opt-in HTML preview, and drives the browser pane", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
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

  // LaTeX: KaTeX mounts a `.katex` node — the raw "$E = mc^2$" is never shown.
  await expect(window.locator(".katex").first()).toBeVisible({ timeout: 10_000 })

  // HTML block defaults to the Code view (transcript stays plain text).
  const preview = window.getByRole("tab", { name: /Preview/ })
  await expect(window.getByRole("tab", { name: /Code/ })).toBeVisible()
  await expect(window.locator('iframe[title="HTML preview"]')).toHaveCount(0)

  // Opting into Preview mounts the sandboxed iframe.
  await preview.click()
  await expect(window.locator('iframe[title="HTML preview"]')).toBeVisible()

  // Browser pane: open it from the tab-bar control, then navigate. The
  // WebContentsView is out-of-DOM, so we assert on the address bar (in DOM).
  // The toggle lives in the WINDOW TITLE BAR now, not a pane's tab bar; `exact`
  // avoids matching the dock's own "Hide preview" button, and we open
  // only if it isn't already (its visibility persists in localStorage across runs).
  const toggle = window.getByRole("button", { name: "Preview", exact: true })
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click()
  const url = window.getByLabel("Preview URL")
  await expect(url).toBeVisible()
  await url.fill("http://localhost:4321")
  await url.press("Enter")
  await expect(url).toHaveValue("http://localhost:4321")
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
      withRepo: true,
      sessions: isolatedSessions
    })
    await expect(appShell(window)).toBeVisible()
    const toggle = window.getByRole("button", { name: "Preview", exact: true })
    if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click()
    const url = window.getByLabel("Preview URL")
    await url.fill(`${origin}/alpha`)
    await url.press("Enter")
    await expect(url).toHaveValue(`${origin}/alpha-history`, { timeout: 10_000 })

    await sessionRow(window, "Preview Beta").click()
    await expect(toggle).toHaveAttribute("aria-pressed", "false")
    await toggle.click()
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

    // Visibility is session state too: hiding Beta must not hide Alpha, and
    // returning to Beta must restore its hidden dock rather than Alpha's state.
    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-pressed", "false")
    await sessionRow(window, "Preview Alpha").click()
    await expect(toggle).toHaveAttribute("aria-pressed", "true")
    await expect(url).toHaveValue(`${origin}/alpha-history`)
    await sessionRow(window, "Preview Beta").click()
    await expect(toggle).toHaveAttribute("aria-pressed", "false")
    await expect(url).toBeHidden()
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
      withRepo: true,
      sessions: isolatedSessions
    })
    await expect(appShell(window)).toBeVisible()
    const toggle = window.getByRole("button", { name: "Preview", exact: true })
    if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click()
    const url = window.getByLabel("Preview URL")
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
    const partition = "persist:jingler-browser-preview:s_preview_alpha"
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

test("keeps Preview visible while Files owns PDFs in two split panes", async ({ launchApp }) => {
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
      withRepo: true,
      sessions: isolatedSessions,
      seed: ({ repoPath }) => {
        writeFileSync(join(repoPath, "alpha.pdf"), "%PDF-1.4\n%%EOF\n")
        writeFileSync(join(repoPath, "beta.pdf"), "%PDF-1.4\n%%EOF\n")
      }
    })
    await expect(appShell(window)).toBeVisible()
    const toggle = window.getByRole("button", { name: "Preview", exact: true })
    if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click()
    const url = window.getByLabel("Preview URL")
    await url.fill(origin)
    await url.press("Enter")

    await window.keyboard.press("Control+Shift+Equal")
    const alphaPane = window.getByTestId("split-pane-0")
    const betaPane = window.getByTestId("split-pane-1")
    // The internet dock follows the focused session. Seed Beta's own browser
    // before opening its PDF so the final visible browser is Beta's retained
    // view, not Alpha's deliberately hidden one.
    await expect(betaPane).toHaveAttribute("data-focused", "true")
    if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click()
    await expect(url).toBeVisible()
    await url.fill(origin)
    await url.press("Enter")

    await window.keyboard.press("Control+Shift+Digit1")
    await expect(alphaPane).toHaveAttribute("data-focused", "true")
    await window.keyboard.press("Meta+Shift+p")
    const picker = window.getByTestId("file-quick-open")
    await expect(picker).toBeVisible()
    await window.getByPlaceholder("Open a file in Preview Alpha…").fill("alpha.pdf")
    await window.getByTestId("palette-item-file:alpha.pdf").click()
    await expect(picker).toBeHidden()
    await expect(alphaPane.getByRole("button", { name: "Files", exact: true })).toHaveAttribute(
      "aria-current",
      "page"
    )

    await window.keyboard.press("Control+Shift+Digit2")
    await expect(betaPane).toHaveAttribute("data-focused", "true")
    await window.keyboard.press("Meta+Shift+p")
    await expect(picker).toBeVisible()
    await window.getByPlaceholder("Open a file in Preview Beta…").fill("beta.pdf")
    await window.getByTestId("palette-item-file:beta.pdf").click()
    await expect(picker).toBeHidden()
    await expect(betaPane.getByRole("button", { name: "Files", exact: true })).toHaveAttribute(
      "aria-current",
      "page"
    )

    await expect
      .poll(() =>
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
      )
      .toEqual(
        expect.arrayContaining([
          expect.stringContaining(origin),
          expect.stringContaining("alpha.pdf"),
          expect.stringContaining("beta.pdf")
        ])
      )
  } finally {
    await closeServer(server)
  }
})
