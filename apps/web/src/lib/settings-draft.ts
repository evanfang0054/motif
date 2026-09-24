import type { AdminSettingItem } from './client'
import { mailerFieldVisible, paymentFieldVisible, storageFieldVisible } from './setting-visibility'

/**
 * 枚举下拉的选项列表。
 *
 * ⚠️ `id` **必须是裸枚举值**：HeroUI 的 Select 建在 React Aria 之上，其 `value`
 * 就是 item 的 `id`（官方 Select 文档：*"The value corresponds to the `id` prop of an item"*），
 * `onChange` 回传的正是它。曾把 id 写成 `opt-<key>-<value>`，后果是三重的：
 *   1. 回传 `opt-BILLING_CURRENCY-cny` 被后端 enum 校验拒掉 —— 用户选的就是
 *      提示里列出的合法值，却报「只能是 cny / usd / …」，看起来自相矛盾；
 *   2. 已存值（裸值）永远匹配不上带前缀的 id，下拉框始终显示为空；
 *   3. 依赖「当前渠道值」查表裁决显隐的字段查不到（`undefined` → 判为不可见），
 *      于是选完 smtp 后 SMTP_* 全不显示。
 * `label` 与 `id` 同为裸值是刻意的：下拉里显示的就是要存进库的值，不给两套写法。
 */
export function enumOptionItems(options: string[] | null): Array<{ id: string; label: string }> {
  return (options ?? []).map((o) => ({ id: o, label: o }))
}

/**
 * 枚举下拉要回显的值，以及它是否来自「未设置时的默认」（issue #79-1.3）。
 *
 * 问题：`MOTIF_MAILER` / `STORAGE_DRIVER` 这类枚举在**未显式设置**时 `value` 是 null，
 * 下拉就显示占位符「选择一个项目」，展开后各项无选中态 —— 但系统其实正按 `defaultHint`
 * （console / local）在跑，同页状态行还写着「已就绪」。管理员据此无法判断当前到底是
 * 「未设置走默认」还是「已设置但没回显」，而这两种状态要采取的动作完全不同。
 *
 * 修法：把**生效值**补上，并由调用方用 `fromDefault` 显式标注「当前按默认生效」。
 * ⚠️ 只在 `defaultHint` 恰好是合法选项时才回填 —— 若默认值不在 options 里（配置写错），
 * 回填一个不存在的 id 只会让下拉显示空白，反而更难排查；此时保持原样。
 */
export function enumDisplayValue(item: {
  value: string | null
  defaultHint: string | null
  options: string[] | null
}): { value: string | null; fromDefault: boolean } {
  if (item.value) return { value: item.value, fromDefault: false }
  const hint = item.defaultHint
  if (hint && (item.options ?? []).includes(hint)) return { value: hint, fromDefault: true }
  return { value: null, fromDefault: false }
}

/**
 * 只提交本组里改动过且**当前可见**的键 —— 密钥框初值恒为空，未输入就不会进 dirty；
 * 可见性过滤防止「切走渠道后，隐藏字段残留的 dirty 被一并提交」。
 */
export function pickUpdates(input: {
  items: AdminSettingItem[]
  dirty: Record<string, string>
  group: AdminSettingItem['group']
}): Record<string, string> {
  const { items, dirty, group } = input
  const keys = new Set(items.filter((i) => i.group === group).map((i) => i.key))
  const draftChannel = (selectorKey: string): string | null =>
    dirty[selectorKey] ?? items.find((i) => i.key === selectorKey)?.value ?? null
  const visible = (key: string): boolean => {
    if (group === 'mailer') return mailerFieldVisible({ key }, draftChannel('MOTIF_MAILER'))
    if (group === 'payment') return paymentFieldVisible({ key }, draftChannel('PAYMENT_CHANNEL'))
    // 切回 local 时 S3_* 被隐藏，其草稿值不应再被提交（与 mailer/payment 同口径）
    if (group === 'storage') return storageFieldVisible({ key }, draftChannel('STORAGE_DRIVER'))
    return true
  }
  return Object.fromEntries(Object.entries(dirty).filter(([k]) => keys.has(k) && visible(k)))
}
