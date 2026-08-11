const PI_PACKAGES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent"
]

const LEGACY_HARNESS_PACKAGES = [
  "@anthropic-ai/claude-agent-sdk",
  "@openai/codex-sdk",
  "@opencode-ai/sdk"
]

const LEADING_SLASH = /^\//
const PLAINTEXT_AUTH_FILE = /(^|\/)(auth|oauth)\.json$/

const packageMarker = (name) => `node_modules/${name}/`

export const auditDeviceBundle = (source) => [
  ...PI_PACKAGES.flatMap((name) =>
    source.includes(packageMarker(name)) ? [] : [`device bundle is missing ${name}`]
  ),
  ...LEGACY_HARNESS_PACKAGES.flatMap((name) =>
    source.includes(packageMarker(name)) ? [`device bundle contains ${name}`] : []
  ),
  ...(source.includes("Copyright (c) 2025 Mario Zechner") && source.includes("MIT License")
    ? []
    : ["device bundle is missing the pi license notice"])
]

export const auditDesktopArchive = (entries) => {
  const normalized = entries.map((entry) => entry.replace(LEADING_SLASH, ""))
  return [
    ...PI_PACKAGES.flatMap((name) =>
      normalized.includes(`${packageMarker(name)}package.json`)
        ? []
        : [`desktop archive is missing ${name}`]
    ),
    ...LEGACY_HARNESS_PACKAGES.flatMap((name) =>
      normalized.some((entry) => entry.startsWith(packageMarker(name)))
        ? [`desktop archive contains ${name}`]
        : []
    ),
    ...normalized.flatMap((entry) =>
      PLAINTEXT_AUTH_FILE.test(entry)
        ? [`desktop archive contains plaintext credential file ${entry}`]
        : []
    )
  ]
}

export const auditRuntimeDependencies = (manifest, label) => {
  const dependencies = manifest.dependencies ?? {}
  return [
    ...PI_PACKAGES.flatMap((name) =>
      dependencies[name] ? [] : [`${label} does not declare ${name}`]
    ),
    ...LEGACY_HARNESS_PACKAGES.flatMap((name) =>
      dependencies[name] ? [`${label} declares legacy dependency ${name}`] : []
    )
  ]
}
