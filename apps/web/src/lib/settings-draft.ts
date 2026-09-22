import type { AdminSettingItem } from './client'
import { mailerFieldVisible, paymentFieldVisible } from './setting-visibility'

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
    return true
  }
  return Object.fromEntries(Object.entries(dirty).filter(([k]) => keys.has(k) && visible(k)))
}
