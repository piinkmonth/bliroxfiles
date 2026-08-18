import fs from 'node:fs'

/**
 * Minimal streaming ZIP writer.
 *
 * Two deliberate choices:
 *
 * - **Store, not deflate.** Almost everything here is video, images or
 *   archives, all of which are already compressed. Deflating them burns CPU for
 *   roughly zero gain, and on a home server that CPU is better spent serving
 *   bytes. Store also means entries are copied straight through with no
 *   buffering.
 *
 * - **Data descriptors.** A local header must carry the CRC and size, which are
 *   not known until the file has been read. Setting bit 3 of the general
 *   purpose flag moves them into a descriptor *after* the data, which is what
 *   makes single-pass streaming possible without buffering a whole file.
 *
 * No ZIP64, so the archive and every entry must stay under 4 GiB. The caller
 * enforces that; see MAX_ZIP_BYTES.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

export function crc32(buf: Buffer, seed = 0): number {
  let c = (seed ^ -1) >>> 0
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0
  return (c ^ -1) >>> 0
}

export interface ZipEntry {
  name: string
  path: string
  size: number
}

/** MS-DOS packed date/time, which is what the ZIP format stores. */
function dosDateTime(d = new Date()): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

export function zipStream(
  entries: ZipEntry[],
  opts: { onDone?: (bytes: number) => void; onError?: (err: unknown) => void } = {},
): ReadableStream<Uint8Array> {
  const { time, date } = dosDateTime()
  // Bit 3: sizes and CRC follow the data. Bit 11: filenames are UTF-8.
  const FLAGS = 0x08 | 0x800

  let offset = 0
  const directory: Buffer[] = []
  let finished = false

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return

      try {
        for (const entry of entries) {
          const nameBuf = Buffer.from(entry.name, 'utf8')
          const localOffset = offset

          const local = Buffer.alloc(30 + nameBuf.length)
          local.writeUInt32LE(0x04034b50, 0) // local file header signature
          local.writeUInt16LE(20, 4) // version needed
          local.writeUInt16LE(FLAGS, 6)
          local.writeUInt16LE(0, 8) // method: store
          local.writeUInt16LE(time, 10)
          local.writeUInt16LE(date, 12)
          // CRC and sizes are zero here; the data descriptor carries the real
          // values once the file has actually been read.
          local.writeUInt32LE(0, 14)
          local.writeUInt32LE(0, 18)
          local.writeUInt32LE(0, 22)
          local.writeUInt16LE(nameBuf.length, 26)
          local.writeUInt16LE(0, 28) // extra field length
          nameBuf.copy(local, 30)

          controller.enqueue(new Uint8Array(local))
          offset += local.length

          let crc = 0
          let written = 0

          const handle = fs.createReadStream(entry.path, { highWaterMark: 1024 * 1024 })
          for await (const chunk of handle) {
            const buf = chunk as Buffer
            crc = crc32(buf, crc)
            written += buf.length
            controller.enqueue(new Uint8Array(buf))
          }
          offset += written

          const descriptor = Buffer.alloc(16)
          descriptor.writeUInt32LE(0x08074b50, 0) // optional but widely expected
          descriptor.writeUInt32LE(crc, 4)
          descriptor.writeUInt32LE(written, 8)
          descriptor.writeUInt32LE(written, 12)
          controller.enqueue(new Uint8Array(descriptor))
          offset += descriptor.length

          const central = Buffer.alloc(46 + nameBuf.length)
          central.writeUInt32LE(0x02014b50, 0) // central directory header
          central.writeUInt16LE(0x031e, 4) // made by: UNIX, spec 3.0
          central.writeUInt16LE(20, 6)
          central.writeUInt16LE(FLAGS, 8)
          central.writeUInt16LE(0, 10) // store
          central.writeUInt16LE(time, 12)
          central.writeUInt16LE(date, 14)
          central.writeUInt32LE(crc, 16)
          central.writeUInt32LE(written, 20)
          central.writeUInt32LE(written, 24)
          central.writeUInt16LE(nameBuf.length, 28)
          central.writeUInt16LE(0, 30)
          central.writeUInt16LE(0, 32)
          central.writeUInt16LE(0, 34)
          central.writeUInt16LE(0, 36)
          central.writeUInt32LE(0o644 << 16, 38) // external attrs: rw-r--r--
          central.writeUInt32LE(localOffset, 42)
          nameBuf.copy(central, 46)
          directory.push(central)
        }

        const dirBuf = Buffer.concat(directory)
        controller.enqueue(new Uint8Array(dirBuf))

        const end = Buffer.alloc(22)
        end.writeUInt32LE(0x06054b50, 0) // end of central directory
        end.writeUInt16LE(0, 4)
        end.writeUInt16LE(0, 6)
        end.writeUInt16LE(directory.length, 8)
        end.writeUInt16LE(directory.length, 10)
        end.writeUInt32LE(dirBuf.length, 12)
        end.writeUInt32LE(offset, 16)
        end.writeUInt16LE(0, 20) // no comment
        controller.enqueue(new Uint8Array(end))

        finished = true
        opts.onDone?.(offset + dirBuf.length + end.length)
        controller.close()
      } catch (err) {
        finished = true
        opts.onError?.(err)
        controller.error(err)
      }
    },

    cancel() {
      // Client hung up mid-archive.
      if (!finished) {
        finished = true
        opts.onError?.(new Error('cancelled'))
      }
    },
  })
}
