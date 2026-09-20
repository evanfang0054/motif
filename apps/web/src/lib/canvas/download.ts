/**
 * 批量下载的纯逻辑：决定「zip 里放哪些条目、叫什么名字」。
 * 抽成纯函数是为了可单测 —— 组件层（CanvasStage）在本仓库没有 DOM 测试环境。
 */

/** 与后端 `buildImageKey` 的扩展名口径保持一致：png / jpg / webp */
export function extForMime(mimeType: string): string {
  if (mimeType.includes('png')) return 'png'
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg'
  return 'webp'
}

export interface DownloadableImage {
  id: string
  serial: number
  name: string
  mimeType: string
  src: string
}

/**
 * 压缩包内的文件名：`003-图片 2.png`。
 *
 * 为什么补扩展名：生成的图片 `name` 只有「图片 N」没有后缀（上传参考图才带），
 * 直接拿 `name` 当文件名解压后是一堆无后缀文件、双击打不开。
 * 已有后缀时不重复追加。
 *
 * ⚠️ 唯一性靠 **serial 前缀**：同一任务内 `serial` 唯一（`nextSerial` 保证），
 * 故无需再做同名去重（那会是不可达分支）。用户上传多张同名参考图也不会撞 —— 前缀不同。
 */
export function zipEntryName(img: DownloadableImage): string {
  const serial = String(img.serial).padStart(3, '0')
  const ext = extForMime(img.mimeType)
  const base = img.name.trim() || `image-${serial}`
  const hasExt = new RegExp(`\\.${ext}$`, 'i').test(base) || /\.[a-z0-9]{2,5}$/i.test(base)
  return `${serial}-${base}${hasExt ? '' : `.${ext}`}`
}

/** 压缩包名：`motif-canvas-<任务短 id>-<N>张-<日期>.zip` */
export function zipFileName(topicId: string, count: number, date: Date = new Date()): string {
  const day = date.toISOString().slice(0, 10)
  const short = topicId.replace(/^top_/, '').slice(0, 8)
  return `motif-canvas-${short}-${count}张-${day}.zip`
}

/** 把选中图片整理成 zip 条目（文件名 + 取字节的地址） */
export function zipEntriesFor(images: DownloadableImage[]): Array<{ name: string; src: string }> {
  return images.map((img) => ({ name: zipEntryName(img), src: img.src }))
}
