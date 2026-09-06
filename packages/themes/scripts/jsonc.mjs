/**
 * Strip `//` and block comments and trailing commas so `JSON.parse` accepts a
 * JSONC file.
 *
 * Character-by-character with a string-literal guard rather than a regex,
 * because `"url": "https://example.com"` contains `//` inside a string and a
 * regex that does not track quoting truncates the value to `"https:`.
 */
const skipComment = (text, index) => {
  if (text[index] !== "/") return null
  if (text[index + 1] === "/") {
    const end = text.indexOf("\n", index)
    return { end: end < 0 ? text.length : end, replacement: "\n" }
  }
  if (text[index + 1] === "*") {
    const end = text.indexOf("*/", index + 2)
    return { end: end < 0 ? text.length + 1 : end + 1, replacement: "" }
  }
  return null
}

export const parseJsonc = (text) => {
  let out = ""
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (!escaped && ch === '"') inString = false
      escaped = !escaped && ch === "\\"
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    const comment = skipComment(text, i)
    if (comment) {
      i = comment.end
      out += comment.replacement
      continue
    }
    out += ch
  }
  // Trailing commas before a closing brace/bracket.
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"))
}
