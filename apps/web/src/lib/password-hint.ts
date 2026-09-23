/**
 * 「建议修改密码」提醒的抑制标记（#84）。
 *
 * 口径（2026-09-23 用户批准的设计 **D12**）：**本次会话**抑制 —— 点过出口后本次会话内不再自动出现，
 * 重新登录 / 新开标签页会再提醒一次（首次仍提示一次）。
 * 故用 `sessionStorage` 而不是 `localStorage`：前者随标签页生命周期失效，正是「本次会话」的语义；
 * 后者是「本机永久」，与本口径不符（改动前就是后者，见 CONTEXT.md 的「会话抑制」词条）。
 *
 * ⚠️ 键**按 userId 分**：同一浏览器换账号登录时，A 点过出口不能把 B 的提醒也吞掉。
 *
 * storage 由调用方注入而不是在模块里直接取 `sessionStorage`：一是纯函数可单测，
 * 二是「访问 storage 本身也会抛异常」（Safari 禁 cookie、沙箱 iframe 等）这件事需要唯一的处理点 ——
 * 直接写成 `isHintDismissed(sessionStorage, id)` 的话，取值发生在 try 之外，异常就漏出去了。
 */
export const PASSWORD_HINT_KEY_PREFIX = 'motif:password-hint-dismissed:'

export function passwordHintKey(userId: string): string {
  return `${PASSWORD_HINT_KEY_PREFIX}${userId}`
}

/** 取会话存储；访问本身可能抛异常，取不到就返回 null（调用方按「无 storage」降级） */
export function sessionStore(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

/** 只认 `'1'`：null / 空串 / 脏数据一律当「没点过」—— 抑制标记宁可少认，不可把提醒误吞掉 */
export function isHintDismissed(storage: Pick<Storage, 'getItem'> | null, userId: string): boolean {
  if (!storage) return false
  try {
    return storage.getItem(passwordHintKey(userId)) === '1'
  } catch {
    // 隐私模式下读也可能抛异常：读不到就照常提醒
    return false
  }
}

/** 写标记；返回是否写成功（写不进去时调用方仍要关掉本次弹窗，只是下次进工作台会再提醒） */
export function markHintDismissed(storage: Pick<Storage, 'setItem'> | null, userId: string): boolean {
  if (!storage) return false
  try {
    storage.setItem(passwordHintKey(userId), '1')
    return true
  } catch {
    return false
  }
}

/**
 * 清掉标记（登出时调用）。
 *
 * 为什么需要它：`sessionStorage` 的天然边界是**标签页**，而 CONTEXT.md 的「会话抑制」词条把边界定在
 * **一次登录**（「重新登录后可再次提示」「重新登录即失效」）。两者靠这一步对齐 ——
 * 不清的话，同一标签页内登出再登录不会重新提醒，词条就成了假描述。
 */
export function clearHintDismissed(storage: Pick<Storage, 'removeItem'> | null, userId: string): void {
  if (!storage) return
  try {
    storage.removeItem(passwordHintKey(userId))
  } catch {
    // 清不掉只影响「重新登录后是否再提醒一次」，不值得冒泡
  }
}
