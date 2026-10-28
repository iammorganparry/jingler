/**
 * Build whisper.cpp's `whisper-cli` for the CURRENT platform/arch and write it to
 * apps/desktop/resources/whisper/<os>-<arch>/ (os: mac|linux|win, matching
 * electron-builder's `${os}`), where electron-builder.yml ships it.
 *
 * whisper.cpp publishes prebuilt binaries only for Windows and ubuntu-x64/arm64
 * (none for macOS, none Metal-enabled), so every platform is built from a pinned
 * tag with cmake for one uniform, reproducible path.
 *
 * Usage: node build-whisper.mjs
 */
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

export const WHISPER_TAG = "v1.9.5"
export const WHISPER_COMMIT = "d1be6fde11ac6e0407606b4e42fe72d34add8037"

const root = resolve(import.meta.dirname, "../..")
const osName = { darwin: "mac", linux: "linux", win32: "win" }[process.platform]
if (osName === undefined) throw new Error(`Unsupported platform ${process.platform}`)
const exe = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli"
const src = join(root, ".cache", "whisper.cpp", `${WHISPER_TAG}-${osName}-${process.arch}`)
const out = join(root, "apps", "desktop", "resources", "whisper", `${osName}-${process.arch}`)

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" })
const git = (args, cwd = src) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

if (!existsSync(join(src, ".git"))) {
  mkdirSync(src, { recursive: true })
  run("git", ["clone", "--depth", "1", "--branch", WHISPER_TAG, "https://github.com/ggml-org/whisper.cpp", src])
}
const head = git(["rev-parse", "HEAD"])
if (head !== WHISPER_COMMIT) throw new Error(`whisper.cpp ${WHISPER_TAG} is ${head}, expected ${WHISPER_COMMIT}`)

// Static, portable binary: no -march=native (the build host's CPU is not the user's),
// no OpenMP/shared libs to ship. Metal's shader library is embedded on macOS.
const flags = [
  "-DCMAKE_BUILD_TYPE=Release",
  "-DBUILD_SHARED_LIBS=OFF",
  "-DGGML_NATIVE=OFF",
  "-DGGML_OPENMP=OFF",
  "-DWHISPER_BUILD_TESTS=OFF",
  "-DWHISPER_BUILD_SERVER=OFF",
  ...(process.arch === "x64" ? ["-DGGML_AVX2=ON", "-DGGML_FMA=ON", "-DGGML_F16C=ON"] : []),
  ...(process.platform === "darwin" ? ["-DGGML_METAL=ON", "-DGGML_METAL_EMBED_LIBRARY=ON", "-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0"] : []),
  ...(process.platform === "win32" ? ["-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded"] : [])
]
run("cmake", ["-B", "build", ...flags], src)
run("cmake", ["--build", "build", "--config", "Release", "--target", "whisper-cli", "-j"], src)

// Single-config generators put it in build/bin, MSVC in build/bin/Release.
const built = [join(src, "build", "bin", exe), join(src, "build", "bin", "Release", exe)].find(existsSync)
if (built === undefined) throw new Error(`whisper-cli not found under ${join(src, "build", "bin")}: ${readdirSync(join(src, "build"))}`)
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
cpSync(built, join(out, exe))
console.log(`whisper-cli ${WHISPER_TAG} -> ${join(out, exe)}`)
