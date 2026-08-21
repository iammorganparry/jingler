import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"

const require = createRequire(import.meta.url)
const ponytailRoot = resolve(dirname(require.resolve("@dietrichgebert/ponytail")), "../..")

export const PONYTAIL_VERSION = "4.9.0"
export const PONYTAIL_EXTENSION_PATH = resolve(ponytailRoot, "pi-extension/index.js")
export const PONYTAIL_SKILLS_PATH = resolve(ponytailRoot, "skills")
