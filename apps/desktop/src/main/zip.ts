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
  const localParts: Array<Buffer> = []
  const centralParts: Array<Buffer> = []
  let offset = 0

  for (const file of files) {
    const name = Buffer.from(safeArchivePath(file.path), "utf8")
    const content = Buffer.from(file.content, "utf8")
    const checksum = crc32(content)
    const local = Buffer.alloc(30)
    write32(local, 0, 0x04034b50)
    write16(local, 4, 20)
    write16(local, 6, 0x0800)
    write32(local, 14, checksum)
    write32(local, 18, content.length)
    write32(local, 22, content.length)
    write16(local, 26, name.length)
    localParts.push(local, name, content)

    const central = Buffer.alloc(46)
    write32(central, 0, 0x02014b50)
    write16(central, 4, 20)
    write16(central, 6, 20)
    write16(central, 8, 0x0800)
    write32(central, 16, checksum)
    write32(central, 20, content.length)
    write32(central, 24, content.length)
    write16(central, 28, name.length)
    write32(central, 42, offset)
    centralParts.push(central, name)
    offset += local.length + name.length + content.length
  }

  const centralSize = centralParts.reduce((size, part) => size + part.length, 0)
  const end = Buffer.alloc(22)
  write32(end, 0, 0x06054b50)
  write16(end, 8, files.length)
  write16(end, 10, files.length)
  write32(end, 12, centralSize)
  write32(end, 16, offset)
  return Buffer.concat([...localParts, ...centralParts, end])
}
