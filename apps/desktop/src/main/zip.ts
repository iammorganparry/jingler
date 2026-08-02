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
const LOCAL_HEADER_SIGNATURE = 0x04034b50
const LOCAL_HEADER_BYTES = 30
const LOCAL_VERSION_OFFSET = 4
const LOCAL_FLAGS_OFFSET = 6
const LOCAL_CHECKSUM_OFFSET = 14
const LOCAL_COMPRESSED_SIZE_OFFSET = 18
const LOCAL_UNCOMPRESSED_SIZE_OFFSET = 22
const LOCAL_NAME_LENGTH_OFFSET = 26
const CENTRAL_HEADER_SIGNATURE = 0x02014b50
const CENTRAL_HEADER_BYTES = 46
const CENTRAL_CREATED_VERSION_OFFSET = 4
const CENTRAL_REQUIRED_VERSION_OFFSET = 6
const CENTRAL_FLAGS_OFFSET = 8
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

const safeArchivePath = (path: string): string => {
  const normalized = path.replaceAll("\\", "/")
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
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
    const content = Buffer.from(file.content, ZIP_TEXT_ENCODING)
    const checksum = crc32(content)
    const local = Buffer.alloc(LOCAL_HEADER_BYTES)
    write32(local, ZIP_SIGNATURE_OFFSET, LOCAL_HEADER_SIGNATURE)
    write16(local, LOCAL_VERSION_OFFSET, ZIP_VERSION)
    write16(local, LOCAL_FLAGS_OFFSET, ZIP_UTF8_FLAG)
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
