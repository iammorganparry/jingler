import { readFileSync } from "node:fs"

/**
 * Read bundled plugin ids from the `to: plugins/<id>` entries in the Electron
 * builder config. Keeping this parser shared makes electron-builder.yml the
 * single source of truth for both packaging and Electron test setup.
 *
 * @param {string} builderConfigPath
 * @returns {string[]}
 */
export const readBundledPluginIds = (builderConfigPath) =>
  [...readFileSync(builderConfigPath, "utf8").matchAll(/^\s*to:\s*plugins\/(\S+)\s*$/gm)].flatMap(
    (match) => (match[1] ? [match[1]] : [])
  )
