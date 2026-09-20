/**
 * 极简 ZIP 写入器（仅 store 存储、不压缩）。
 *
 * 为什么手写：契约的依赖白名单只允许新增 `zustand`，仓库没有 fflate/jszip。
 * 「批量下载」需要把 N 张图合成一个文件，而 store 模式（method 0）不需要任何压缩算法 ——
 * 只要 CRC32 + 三个头部结构，约 80 行即可，且能用系统 `unzip` 独立验证。
 *
 * 参考 ZIP 规范（PKWARE APPNOTE 4.3.6）的：
 *   4.3.7 local file header / 4.3.12 central directory structure / 4.3.16 EOCD
 * 适配取舍：不压缩、不加密、不支持 zip64（批量下载的体量远不到 4GB 门槛）、无目录项。
 */

export interface ZipEntry {
  /** 压缩包内的文件名（UTF-8；含中文时靠 flag bit 11 标记） */
  name: string
  data: Uint8Array
}

/** CRC32（IEEE 802.3）查表法 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** MS-DOS 时间戳：秒只有 2 秒精度，年份从 1980 起算 */
function dosDateTime(d: Date): { time: number; date: number } {
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)) & 0xffff
  const year = Math.max(1980, d.getFullYear())
  const date = (((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff
  return { time, date }
}

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
/** bit 11：文件名是 UTF-8（否则解压端会按 CP437 解出乱码） */
const FLAG_UTF8 = 0x0800

const enc = new TextEncoder()

/**
 * 打包。`modifiedAt` 可注入 —— 时间戳是产物字节的一部分，注入后测试才能比对确定性输出。
 */
export function buildZip(entries: ZipEntry[], modifiedAt: Date = new Date()): Uint8Array {
  const { time, date } = dosDateTime(modifiedAt)
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name)
    const crc = crc32(entry.data)
    const size = entry.data.length

    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, SIG_LOCAL, true)
    lv.setUint16(4, 20, true) // version needed
    lv.setUint16(6, FLAG_UTF8, true)
    lv.setUint16(8, 0, true) // method = store
    lv.setUint16(10, time, true)
    lv.setUint16(12, date, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, size, true) // compressed size
    lv.setUint32(22, size, true) // uncompressed size
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true) // extra length
    local.set(nameBytes, 30)
    locals.push(local, entry.data)

    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, SIG_CENTRAL, true)
    cv.setUint16(4, 20, true) // version made by
    cv.setUint16(6, 20, true) // version needed
    cv.setUint16(8, FLAG_UTF8, true)
    cv.setUint16(10, 0, true) // method
    cv.setUint16(12, time, true)
    cv.setUint16(14, date, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, size, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint16(30, 0, true) // extra
    cv.setUint16(32, 0, true) // comment
    cv.setUint16(34, 0, true) // disk number start
    cv.setUint16(36, 0, true) // internal attrs
    cv.setUint32(38, 0, true) // external attrs
    cv.setUint32(42, offset, true) // relative offset of local header
    central.set(nameBytes, 46)
    centrals.push(central)

    offset += local.length + size
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, SIG_EOCD, true)
  ev.setUint16(4, 0, true) // this disk
  ev.setUint16(6, 0, true) // disk with central dir
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true) // central dir offset
  ev.setUint16(20, 0, true) // comment length

  const total = offset + centralSize + eocd.length
  const out = new Uint8Array(total)
  let p = 0
  for (const chunk of locals) {
    out.set(chunk, p)
    p += chunk.length
  }
  for (const c of centrals) {
    out.set(c, p)
    p += c.length
  }
  out.set(eocd, p)
  return out
}
