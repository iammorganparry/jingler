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

it("checks bytes, permissions and absence after temporary file fsync, preserving normal writes", () => {
  const root = mkdtempSync(join(tmpdir(), "anchor-cas-"))
  try {
    const worker = fileURLToPath(new URL("./anchored-fs-worker.ts", import.meta.url))
    const script = join(root, "cas.mjs")
    writeFileSync(script, `import { operate } from ${JSON.stringify(worker)};
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
const root = ${JSON.stringify(root)};
const target = root + '/file';
const sha256 = createHash('sha256').update('base').digest('hex');
const fsync = fs.fsyncSync;
for (const variant of ['bytes', 'permissions', 'absent']) {
  fs.rmSync(target, {force:true});
  if (variant !== 'absent') { fs.writeFileSync(target, 'base'); fs.chmodSync(target, 0o600); }
  fs.fsyncSync = fd => {
    fsync(fd);
    if (variant === 'permissions') fs.chmodSync(target, 0o700);
    else fs.writeFileSync(target, 'late');
  };
  syncBuiltinESMExports();
  let refused = false;
  try { operate({op:'write', path:target, bytes:Buffer.from('restore').toString('base64'), expected:variant === 'absent' ? null : {sha256,permissions:0o600}}); }
  catch(error) { if (!error.message.includes('after backup')) throw error; refused = true; }
  if (!refused || fs.readFileSync(target,'utf8') === 'restore') throw new Error('Late change overwritten');
}
fs.fsyncSync = fsync; syncBuiltinESMExports();
operate({op:'write',path:target,bytes:Buffer.from('normal').toString('base64')});
if(fs.readFileSync(target,'utf8') !== 'normal') throw new Error('Normal write failed');
`)
    execFileSync(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), script], { stdio: "pipe" })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it("bounds allocations by observed size and rejects growth and preserves file metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "anchor-bounded-"))
  try {
    const worker = fileURLToPath(new URL("./anchored-fs-worker.ts", import.meta.url))
    const script = join(root, "bounded.mjs")
    writeFileSync(script, `import { operate } from ${JSON.stringify(worker)};
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const path = ${JSON.stringify(join(root, "file"))};
const limit = 1024;
fs.writeFileSync(path, Buffer.alloc(limit)); fs.chmodSync(path, 0o640);
fs.linkSync(path, path + '-link');
const result = operate({op:'read',path,limit});
if (Buffer.from(result.bytes,'base64').length !== limit || result.mode !== 0o640 || result.nlink !== 2) throw new Error('Boundary or metadata lost');
fs.appendFileSync(path, 'x');
try { operate({op:'read',path,limit}); throw new Error('Oversize accepted'); }
catch(error) { if (!error.message.includes('size limit')) throw error; }
fs.writeFileSync(path, 'small');
const alloc = Buffer.alloc;
let allocated = 0;
Buffer.alloc = (size, ...args) => { allocated = size; return alloc(size, ...args); };
const small = operate({op:'read',path,limit:32 * 1024 * 1024});
Buffer.alloc = alloc;
if (allocated !== 6 || Buffer.from(small.bytes,'base64').toString() !== 'small' || small.mode !== 0o640 || small.nlink !== 2) throw new Error('Small read overallocated or lost metadata');
const original = fs.readSync;
let total = 0;
fs.readSync = (fd, buffer, offset, length, position) => {
  if (total === 0) fs.appendFileSync(path, Buffer.alloc(limit * 10));
  const count = original(fd, buffer, offset, Math.min(length, 17), position);
  total += count; return count;
};
syncBuiltinESMExports();
try { operate({op:'read',path,limit}); throw new Error('Growth accepted'); }
catch(error) { if (!error.message.includes('observed size')) throw error; }
if(total !== 6) throw new Error('Read was not bounded');
fs.readSync = original; syncBuiltinESMExports();
execFileSync('mkfifo',[path+'-fifo']);
try { operate({op:'read',path:path+'-fifo',limit}); throw new Error('FIFO accepted'); }
catch(error) { if (!error.message.includes('Unsafe file type')) throw error; }
fs.mkdirSync(path + '-directory');
try { operate({op:'read',path:path+'-directory',limit}); throw new Error('Directory accepted'); }
catch(error) { if (!error.message.includes('Unsafe file type')) throw error; }
`)
    execFileSync(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), script], { stdio: "pipe" })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it("rejects repeated ancestor swaps or pins cwd before later name swaps without exposing external bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "anchor-repeat-"))
  try {
    const worker = fileURLToPath(new URL("./anchored-fs-worker.ts", import.meta.url))
    const script = join(root, "repeat.mjs")
    writeFileSync(script, `import { enterDirectory } from ${JSON.stringify(worker)};
import fs from 'node:fs';
const root = ${JSON.stringify(root)};
fs.mkdirSync(root+'/external'); fs.writeFileSync(root+'/external/project.json','external-secret');
for(let i=0;i<30;i++) {
  const name = 'ancestor'+i;
  fs.mkdirSync(root+'/'+name); fs.writeFileSync(root+'/'+name+'/project.json','original');
  let refused = false;
  try { enterDirectory(root+'/'+name, false, false, part => {
    if(part === name) {
      fs.renameSync(name,name+'-held'); fs.symlinkSync(root+'/external',name);
      if(i % 2) { fs.unlinkSync(name); fs.renameSync(name+'-held',name); }
    }
  }); } catch(error) { if(!error.message.includes('changed during descent')) throw error; refused=true; }
  if(!refused) {
    // Rename after validated descent: relative reads remain in the original inode.
    fs.renameSync(root+'/'+name,root+'/'+name+'-held'); fs.symlinkSync(root+'/external',root+'/'+name);
    if(fs.readFileSync('project.json','utf8') !== 'original') throw new Error('External bytes exposed');
  }
}
`)
    execFileSync(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), script], { stdio: "pipe" })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
