export interface ZipFile {
  readonly path: string
  readonly content: string
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return value >>> 0
})

const ZIP_VERSION = 20
const ZIP_UTF8_FLAG = 0x0800
const ZIP_SIGNATURE_OFFSET = 0
const ZIP_TEXT_ENCODING = "utf8"
// A fixed, valid DOS timestamp (1980-01-01 00:00:00). Leaving the mod-time/date
// fields zero encodes an INVALID DOS date (day 0, month 0), which strict
// unzippers reject; a determinate, valid stamp also keeps exports byte-stable.
// DOS date = (year-1980)<<9 | month<<5 | day → (0<<9)|(1<<5)|1 = 0x0021.
const DOS_MOD_TIME = 0x0000
const DOS_MOD_DATE = 0x0021
const LOCAL_HEADER_SIGNATURE = 0x04034b50
const LOCAL_HEADER_BYTES = 30
const LOCAL_VERSION_OFFSET = 4
const LOCAL_FLAGS_OFFSET = 6
const LOCAL_MOD_TIME_OFFSET = 10
const LOCAL_MOD_DATE_OFFSET = 12
const LOCAL_CHECKSUM_OFFSET = 14
const LOCAL_COMPRESSED_SIZE_OFFSET = 18
const LOCAL_UNCOMPRESSED_SIZE_OFFSET = 22
const LOCAL_NAME_LENGTH_OFFSET = 26
const CENTRAL_HEADER_SIGNATURE = 0x02014b50
const CENTRAL_HEADER_BYTES = 46
const CENTRAL_CREATED_VERSION_OFFSET = 4
const CENTRAL_REQUIRED_VERSION_OFFSET = 6
const CENTRAL_FLAGS_OFFSET = 8
const CENTRAL_MOD_TIME_OFFSET = 12
const CENTRAL_MOD_DATE_OFFSET = 14
const CENTRAL_CHECKSUM_OFFSET = 16
const CENTRAL_COMPRESSED_SIZE_OFFSET = 20
const CENTRAL_UNCOMPRESSED_SIZE_OFFSET = 24
const CENTRAL_NAME_LENGTH_OFFSET = 28
const CENTRAL_LOCAL_OFFSET = 42
const END_RECORD_SIGNATURE = 0x06054b50
const END_RECORD_BYTES = 22
const END_DISK_ENTRIES_OFFSET = 8
const END_TOTAL_ENTRIES_OFFSET = 10
const END_CENTRAL_SIZE_OFFSET = 12
const END_CENTRAL_OFFSET_OFFSET = 16
const MAX_ZIP_ENTRY_COUNT = 65_535
const MAX_ZIP_CONTENT_BYTES = 128 * 1024 * 1024
// The ZIP name-length field is 16-bit; a longer name silently wraps and corrupts
// the archive, so reject it up front.
const MAX_ZIP_NAME_BYTES = 0xffff

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0)
  return (crc ^ 0xffffffff) >>> 0
}

const write16 = (buffer: Buffer, offset: number, value: number): void => {
  buffer.writeUInt16LE(value, offset)
}

const write32 = (buffer: Buffer, offset: number, value: number): void => {
  buffer.writeUInt32LE(value >>> 0, offset)
}

/**
 * Percent-decode up to a few times so a doubly-encoded traversal (`%252e%252e`)
 * can't slip past the segment checks. Mirrors `decodedPath` in
 * packages/memory `lint.ts`.
 */
const decodedArchivePath = (path: string): string => {
  let decoded = path
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
    } catch {
      break
    }
  }
  return decoded
}

/**
 * Mirrors packages/memory `unsafeMemoryPathReason` (@jingler/memory is not a
 * dependency of the desktop app, so its validator can't be imported here). The
 * reserved-namespace and outer-whitespace rules are intentionally omitted — the
 * vault export legitimately ships `.obsidian/` and `_jingler/` roots. Every
 * other check is kept: without them a `C:/secret.md` (drive-qualified) or
 * `file:...` (scheme-qualified) entry, a NUL byte, or a percent-encoded `..`
 * would resolve OUTSIDE the chosen directory on extract, especially on Windows.
 */
const safeArchivePath = (path: string): string => {
  const normalized = path.replaceAll("\\", "/")
  const decoded = decodedArchivePath(normalized)
  const segments = decoded.split("/")
  const unsafe =
    path === "" ||
    decoded.includes("\0") ||
    decoded.startsWith("/") ||
    /^[A-Za-z]:/.test(decoded) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(decoded) ||
    segments.includes("..") ||
    segments.some((segment) => segment === "." || segment === "")
  if (unsafe) {
    throw new Error(`Unsafe vault export path: ${path}`)
  }
  return normalized
}

/** Build a portable, uncompressed ZIP archive without introducing a native dependency. */
export const createZipArchive = (files: ReadonlyArray<ZipFile>): Buffer => {
  if (files.length > MAX_ZIP_ENTRY_COUNT) {
    throw new Error(`Vault export exceeds ${MAX_ZIP_ENTRY_COUNT} ZIP entries`)
  }
  const contentBytes = files.reduce(
    (total, file) => total + Buffer.byteLength(file.content, ZIP_TEXT_ENCODING),
    0
  )
  if (contentBytes > MAX_ZIP_CONTENT_BYTES) {
    throw new Error("Vault export exceeds the 128 MiB archive limit")
  }
  const localParts: Array<Buffer> = []
  const centralParts: Array<Buffer> = []
  let offset = 0
  const archivePaths = new Set<string>()

  for (const file of files) {
    const archivePath = safeArchivePath(file.path)
    const normalizedArchivePath = archivePath.toLocaleLowerCase("en-US")
    if (archivePaths.has(normalizedArchivePath)) {
      throw new Error(`Duplicate vault export path: ${archivePath}`)
    }
    archivePaths.add(normalizedArchivePath)
    const name = Buffer.from(archivePath, ZIP_TEXT_ENCODING)
    if (name.length > MAX_ZIP_NAME_BYTES) {
      throw new Error(`Vault export path exceeds ${MAX_ZIP_NAME_BYTES} bytes: ${archivePath}`)
    }
    const content = Buffer.from(file.content, ZIP_TEXT_ENCODING)
    const checksum = crc32(content)
    const local = Buffer.alloc(LOCAL_HEADER_BYTES)
    write32(local, ZIP_SIGNATURE_OFFSET, LOCAL_HEADER_SIGNATURE)
    write16(local, LOCAL_VERSION_OFFSET, ZIP_VERSION)
    write16(local, LOCAL_FLAGS_OFFSET, ZIP_UTF8_FLAG)
    write16(local, LOCAL_MOD_TIME_OFFSET, DOS_MOD_TIME)
    write16(local, LOCAL_MOD_DATE_OFFSET, DOS_MOD_DATE)
    write32(local, LOCAL_CHECKSUM_OFFSET, checksum)
    write32(local, LOCAL_COMPRESSED_SIZE_OFFSET, content.length)
    write32(local, LOCAL_UNCOMPRESSED_SIZE_OFFSET, content.length)
    write16(local, LOCAL_NAME_LENGTH_OFFSET, name.length)
    localParts.push(local, name, content)

    const central = Buffer.alloc(CENTRAL_HEADER_BYTES)
    write32(central, ZIP_SIGNATURE_OFFSET, CENTRAL_HEADER_SIGNATURE)
    write16(central, CENTRAL_CREATED_VERSION_OFFSET, ZIP_VERSION)
    write16(central, CENTRAL_REQUIRED_VERSION_OFFSET, ZIP_VERSION)
    write16(central, CENTRAL_FLAGS_OFFSET, ZIP_UTF8_FLAG)
    write16(central, CENTRAL_MOD_TIME_OFFSET, DOS_MOD_TIME)
    write16(central, CENTRAL_MOD_DATE_OFFSET, DOS_MOD_DATE)
    write32(central, CENTRAL_CHECKSUM_OFFSET, checksum)
    write32(central, CENTRAL_COMPRESSED_SIZE_OFFSET, content.length)
    write32(central, CENTRAL_UNCOMPRESSED_SIZE_OFFSET, content.length)
    write16(central, CENTRAL_NAME_LENGTH_OFFSET, name.length)
    write32(central, CENTRAL_LOCAL_OFFSET, offset)
    centralParts.push(central, name)
    offset += local.length + name.length + content.length
  }

  const centralSize = centralParts.reduce((size, part) => size + part.length, 0)
  const end = Buffer.alloc(END_RECORD_BYTES)
  write32(end, ZIP_SIGNATURE_OFFSET, END_RECORD_SIGNATURE)
  write16(end, END_DISK_ENTRIES_OFFSET, files.length)
  write16(end, END_TOTAL_ENTRIES_OFFSET, files.length)
  write32(end, END_CENTRAL_SIZE_OFFSET, centralSize)
  write32(end, END_CENTRAL_OFFSET_OFFSET, offset)
  return Buffer.concat([...localParts, ...centralParts, end])
}
