import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

it("refuses an ancestor swapped between no-follow open and chdir before touching external files", () => {
  const root = mkdtempSync(join(tmpdir(), "anchor-race-"))
  try {
    mkdirSync(join(root, "ancestor")); mkdirSync(join(root, "external"))
    writeFileSync(join(root, "external", "sentinel"), "untouched")
    const worker = fileURLToPath(new URL("./anchored-fs-worker.ts", import.meta.url))
    const script = join(root, "race.mjs")
    writeFileSync(script, `import { enterDirectory } from ${JSON.stringify(worker)};
import { renameSync, symlinkSync, writeFileSync } from 'node:fs';
const root = ${JSON.stringify(root)};
try { enterDirectory(root + '/ancestor', false, false, (part) => {
  if (part === 'ancestor') { renameSync('ancestor', 'held'); symlinkSync(root + '/external', 'ancestor'); }
}); writeFileSync('sentinel', 'changed'); process.exitCode = 2;
} catch (error) { if (!error.message.includes('changed during descent')) throw error; }
`)
    execFileSync(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), script], { stdio: "pipe" })
    expect(readFileSync(join(root, "external", "sentinel"), "utf8")).toBe("untouched")
  } finally { rmSync(root, { recursive: true, force: true }) }
})
