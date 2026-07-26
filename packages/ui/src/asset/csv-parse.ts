/**
 * A single-pass RFC-4180 CSV/TSV parser.
 *
 * Pure, dependency-free, and written as a character loop rather than a
 * `split`-and-regex pipeline because it may be handed a 25 MB export: a naive
 * `text.split("\n")` allocates one string per line up front and then can't even
 * be right (a quoted field may CONTAIN a newline), and a global regex over that
 * much text backtracks badly. One pass, one accumulator per field, is the only
 * shape that stays correct AND doesn't spike memory.
 */

const COMMA = ","
const TAB = "\t"

/**
 * Comma or tab, sniffed from the header line.
 *
 * A `.tsv` arrives at the viewer as kind "csv" (see `extensionToKind`), so the
 * table can't assume commas. We count UNQUOTED delimiters up to the first row
 * break and let the majority win — a comma-delimited file whose first cell is a
 * quoted `"a, b"` shouldn't be read as tab-delimited on the strength of that one
 * embedded comma.
 */
const detectDelimiter = (text: string): string => {
  let commas = 0
  let tabs = 0
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      inQuotes = !inQuotes
    } else if (inQuotes) {
      // A newline inside a quoted header cell is not a row break, so keep going.
    } else if (c === "\n") {
      break
    } else if (c === COMMA) {
      commas++
    } else if (c === TAB) {
      tabs++
    }
  }
  return tabs > commas ? TAB : COMMA
}

/**
 * Parse `text` into rows of string cells. First row is whatever the file's
 * first line is — this parser does not treat the header specially.
 *
 * Handles quoted fields carrying the delimiter, doubled-quote escapes (`""`),
 * embedded newlines inside quotes, and both CRLF and LF line endings. A trailing
 * newline does NOT yield a phantom empty final row, but a genuine trailing empty
 * field (`a,b,`) is preserved.
 */
export const parseCsv = (text: string, delimiter?: string): string[][] => {
  const delim = delimiter ?? detectDelimiter(text)
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  // Whether nothing has been consumed for the current field yet. Tracks two
  // things at once: a leading `"` may open a quoted section ONLY here, and at
  // end-of-input it distinguishes "the file ended on a clean row break" (drop
  // the phantom row) from "a real, possibly-empty final field is pending".
  let fieldStart = true
  const n = text.length

  for (let i = 0; i < n; i++) {
    const c = text[i]!

    if (inQuotes) {
      if (c === '"') {
        // A doubled quote inside a quoted field is one literal quote; anything
        // else closes the quoted section.
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
      continue
    }

    if (c === '"' && fieldStart) {
      inQuotes = true
      fieldStart = false
      continue
    }

    if (c === delim) {
      row.push(field)
      field = ""
      fieldStart = true
      continue
    }

    if (c === "\r" || c === "\n") {
      // Collapse CRLF into one break; a lone \r (old-Mac) or lone \n both count.
      if (c === "\r" && text[i + 1] === "\n") i++
      row.push(field)
      rows.push(row)
      row = []
      field = ""
      fieldStart = true
      continue
    }

    field += c
    fieldStart = false
  }

  // Flush a final row unless the input ended exactly on a row break. `fieldStart`
  // is still true there (nothing consumed since the break), so `!fieldStart`
  // catches a dangling last field while `row.length` catches a trailing empty
  // field like the `,` at the end of `a,b,`.
  if (!fieldStart || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows
}
