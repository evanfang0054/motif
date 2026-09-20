import { describe, expect, it } from 'vitest'
import { buildZip, crc32, readZip as readZipLib } from '@/lib/zip'
import { zipEntriesFor, zipEntryName, zipFileName } from '@/lib/canvas/download'

const bytes = (s: string) => new TextEncoder().encode(s)

/** 从产物里读回条目（独立于写入端实现：按 EOCD → 中央目录 → 本地头逐层解析） */
function readZip(zip: Uint8Array): Array<{ name: string; data: Uint8Array; crc: number }> {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const eocd = zip.length - 22
  expect(dv.getUint32(eocd, true)).toBe(0x06054b50)
  const total = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  const out: Array<{ name: string; data: Uint8Array; crc: number }> = []
  for (let i = 0; i < total; i += 1) {
    expect(dv.getUint32(p, true)).toBe(0x02014b50)
    const crc = dv.getUint32(p + 16, true)
    const size = dv.getUint32(p + 24, true)
    const nameLen = dv.getUint16(p + 28, true)
    const rel = dv.getUint32(p + 42, true)
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen))
    // 本地头
    expect(dv.getUint32(rel, true)).toBe(0x04034b50)
    const localNameLen = dv.getUint16(rel + 26, true)
    const start = rel + 30 + localNameLen
    out.push({ name, data: zip.subarray(start, start + size), crc })
    p += 46 + nameLen
  }
  return out
}

describe('crc32', () => {
  it('对已知向量正确（IEEE 802.3）', () => {
    expect(crc32(bytes(''))).toBe(0)
    expect(crc32(bytes('123456789'))).toBe(0xcbf43926)
    expect(crc32(bytes('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339)
  })
})

describe('buildZip（仅 store，不压缩）', () => {
  const fixed = new Date('2026-09-20T10:00:00Z')

  it('条目可被逐层解析回来，名字与内容一致', () => {
    const zip = buildZip(
      [
        { name: '001-a.txt', data: bytes('hello') },
        { name: '002-b.txt', data: bytes('world!') },
      ],
      fixed
    )
    const entries = readZip(zip)
    expect(entries.map((e) => e.name)).toEqual(['001-a.txt', '002-b.txt'])
    expect(new TextDecoder().decode(entries[0].data)).toBe('hello')
    expect(new TextDecoder().decode(entries[1].data)).toBe('world!')
  })

  it('中央目录里的 CRC 与内容自洽（解压端就是靠它校验）', () => {
    const zip = buildZip([{ name: 'x.bin', data: bytes('123456789') }], fixed)
    expect(readZip(zip)[0].crc).toBe(0xcbf43926)
  })

  it('method = store（不压缩）：compressed size === uncompressed size', () => {
    const zip = buildZip([{ name: 'x.txt', data: bytes('aaaaaaaaaaaaaaaaaaaa') }], fixed)
    const dv = new DataView(zip.buffer)
    expect(dv.getUint16(8, true)).toBe(0) // local header: compression method
    expect(dv.getUint32(18, true)).toBe(dv.getUint32(22, true))
  })

  it('中文文件名标记 UTF-8（bit 11），名字能原样读回', () => {
    const zip = buildZip([{ name: '003-图片 2.png', data: bytes('x') }], fixed)
    const dv = new DataView(zip.buffer)
    expect(dv.getUint16(6, true) & 0x0800).toBe(0x0800)
    expect(readZip(zip)[0].name).toBe('003-图片 2.png')
  })

  it('空包也合法（0 条目）', () => {
    const zip = buildZip([], fixed)
    expect(readZip(zip)).toEqual([])
  })

  it('同样的输入 + 同样的时间戳 → 同样的字节（确定性，时间戳可注入）', () => {
    const a = buildZip([{ name: 'a', data: bytes('1') }], fixed)
    const b = buildZip([{ name: 'a', data: bytes('1') }], fixed)
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('二进制内容不被改写（含 0x00 / 0xFF）', () => {
    const raw = new Uint8Array([0, 255, 0, 128, 66, 77])
    const zip = buildZip([{ name: 'r.bin', data: raw }], fixed)
    expect(Array.from(readZip(zip)[0].data)).toEqual(Array.from(raw))
  })
})

describe('zipEntryName', () => {
  const img = (over: Partial<Parameters<typeof zipEntryName>[0]>) => ({
    id: 'c1',
    serial: 3,
    name: '图片 2',
    mimeType: 'image/webp',
    src: '/api/canvas-images/c1',
    ...over,
  })

  it('生成的图（name 无后缀）补上 mimeType 对应的扩展名', () => {
    expect(zipEntryName(img({}))).toBe('003-图片 2.webp')
    expect(zipEntryName(img({ mimeType: 'image/png' }))).toBe('003-图片 2.png')
    expect(zipEntryName(img({ mimeType: 'image/jpeg' }))).toBe('003-图片 2.jpg')
  })

  it('已有后缀时不重复追加', () => {
    expect(zipEntryName(img({ name: '参考图.png', mimeType: 'image/png' }))).toBe('003-参考图.png')
    expect(zipEntryName(img({ name: 'ref.jpg', mimeType: 'image/jpeg' }))).toBe('003-ref.jpg')
  })

  it('serial 补零到 3 位（与画布上的 #NNN 一致）', () => {
    expect(zipEntryName(img({ serial: 1 }))).toBe('001-图片 2.webp')
    expect(zipEntryName(img({ serial: 12 }))).toBe('012-图片 2.webp')
  })

  it('name 为空时兜底', () => {
    expect(zipEntryName(img({ name: '   ' }))).toBe('003-image-003.webp')
  })
})

describe('zipEntriesFor（文件名唯一性）', () => {
  const mk = (serial: number, name: string) => ({ id: `c${serial}`, serial, name, mimeType: 'image/png', src: `/s/${serial}` })

  it('serial 不同 ⇒ 文件名必不同（唯一性靠 serial 前缀，无需去重分支）', () => {
    const out = zipEntriesFor([mk(1, '图片 1'), mk(2, '图片 1'), mk(3, '图片 1')])
    expect(out.map((o) => o.name)).toEqual(['001-图片 1.png', '002-图片 1.png', '003-图片 1.png'])
    expect(new Set(out.map((o) => o.name)).size).toBe(3)
  })

  it('同一批里即使名字全同也不会互相覆盖（前缀兜住）', () => {
    const many = Array.from({ length: 12 }, (_, i) => mk(i + 1, '参考图.png'))
    const names = zipEntriesFor(many).map((o) => o.name)
    expect(new Set(names).size).toBe(12)
  })

  it('src 原样带出（下载时按它取字节）', () => {
    expect(zipEntriesFor([mk(7, 'a')])[0].src).toBe('/s/7')
  })
})

describe('zipFileName', () => {
  it('含任务短 id、张数与日期', () => {
    expect(zipFileName('top_3a727e09c4f911f175b0d4d2d05afd28', 4, new Date('2026-09-20T10:00:00Z'))).toBe(
      'motif-canvas-3a727e09-4张-2026-09-20.zip'
    )
  })
})

describe('readZip（库的读侧，与写侧对称）', () => {
  it('往返自洽：条目名与字节逐字节一致（含中文名与空文件）', () => {
    const entries = [
      { name: 'canvas.json', data: bytes('{"app":"motif"}') },
      { name: 'files/003-参考图.png', data: bytes('PNG-BYTES') },
      { name: 'empty.bin', data: new Uint8Array(0) },
    ]
    const files = readZipLib(buildZip(entries, new Date('2026-09-20T10:00:00Z')))
    expect([...files.keys()].sort()).toEqual(['canvas.json', 'empty.bin', 'files/003-参考图.png'])
    for (const e of entries) expect(files.get(e.name)).toEqual(e.data)
  })

  it('拒收压缩条目（method = 8）并给出可判文案', () => {
    const zip = buildZip([{ name: 'a.txt', data: bytes('hello') }])
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    const central = dv.getUint32(zip.length - 22 + 16, true)
    dv.setUint16(central + 10, 8, true) // 把中央目录的 method 改成 deflate
    expect(() => readZipLib(zip)).toThrow(/压缩/)
  })

  it('拒收 zip64（EOCD 条目数哨兵）', () => {
    const zip = buildZip([{ name: 'a.txt', data: bytes('hello') }])
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    dv.setUint16(zip.length - 22 + 10, 0xffff, true)
    expect(() => readZipLib(zip)).toThrow(/zip64/)
  })

  it('缺 EOCD 时明确报错（不是静默返回空）', () => {
    expect(() => readZipLib(new Uint8Array(64).fill(7))).toThrow(/不是合法的 zip/)
  })

  it('中央目录签名损坏时报错', () => {
    const zip = buildZip([{ name: 'a.txt', data: bytes('hello') }])
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    dv.setUint32(dv.getUint32(zip.length - 22 + 16, true), 0x11111111, true)
    expect(() => readZipLib(zip)).toThrow(/中央目录/)
  })

  // 越界的畸形输入必须给可判文案：不能把 DataView 的 RangeError 直接抛给用户
  it('短于 EOCD 的输入：明确报错而不是 RangeError', () => {
    for (const n of [0, 1, 21]) {
      let msg = ''
      try {
        readZipLib(new Uint8Array(n))
      } catch (e) {
        msg = e instanceof Error ? e.message : String(e)
      }
      expect(msg).toMatch(/不是合法的 zip/)
      expect(msg).not.toMatch(/Offset is outside/)
    }
  })

  it('中央目录偏移越界：明确报错而不是 RangeError', () => {
    const zip = buildZip([{ name: 'a.txt', data: bytes('hello') }])
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    dv.setUint32(zip.length - 22 + 16, zip.length + 500, true) // 指向缓冲区之外
    expect(() => readZipLib(zip)).toThrow(/中央目录/)
  })

  it('local header 偏移越界：明确报错而不是 RangeError', () => {
    const zip = buildZip([{ name: 'a.txt', data: bytes('hello') }])
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    const central = dv.getUint32(zip.length - 22 + 16, true)
    dv.setUint32(central + 42, zip.length + 500, true) // localOffset 指向缓冲区之外
    expect(() => readZipLib(zip)).toThrow(/条目头部损坏/)
  })
})
