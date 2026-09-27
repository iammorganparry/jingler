const scalar = (value: string): string => {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value)
      return typeof parsed === "string" ? parsed : value.slice(1, -1)
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'")
  }
  return value
}

export const skillBody = (content: string): string =>
  content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "")

const frontmatterField = (content: string, key: string): string | null => {
  const lines = content.split(/\r?\n/)
  const index = lines.findIndex((line) => line.startsWith(`${key}:`))
  if (index < 0) return null
  const value = lines[index]!.slice(key.length + 1).trim()
  if (!/^[>|][+-]?$/.test(value)) return value ? scalar(value) : null

  const block: string[] = []
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]!
    if (line.length > 0 && !/^\s/.test(line)) break
    block.push(line.trim())
  }
  const joined = value.startsWith("|") ? block.join("\n") : block.join(" ")
  return joined.trim() || null
}

const baseName = (entry: string): string => entry.replace(/\.(md|skill)$/i, "")

export const skillMetadataFromContent = (
  content: string,
  fallbackName: string
): { readonly name: string; readonly description: string } => ({
  name: frontmatterField(content, "name") ?? baseName(fallbackName),
  description: frontmatterField(content, "description") ?? "Skill"
})
