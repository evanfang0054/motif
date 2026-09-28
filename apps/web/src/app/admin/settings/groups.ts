import type { AdminSettingItem } from '@/lib/client'

/**
 * 系统设置页的分组标题与显示顺序。
 *
 * 为什么抽到独立模块、而不是留在 `page.tsx` 里：
 * 1. 路由模块的导出受 Next 白名单约束，页面里不能挂业务常量（同类告诫见 `app/admin/nav.ts` 的注释）；
 * 2. 抽出来才能被单测钉住 —— `GROUP_ORDER` 的类型是**数组**、不穷举，漏掉一个分组不会编译失败，
 *    只会让该分组整组不渲染（`GROUP_TITLE` 是 `Record`，漏键会编译失败，两者强度不同）。
 */
export const GROUP_TITLE: Record<AdminSettingItem['group'], string> = {
  generation: '生图网关',
  credits: '额度与奖励',
  payment: '支付与套餐',
  mailer: '邮件发信',
  llm: '提示词增强',
  storage: '图片存储',
  // 该分区**没有任何配置键**，只承载「提示词源状态 + 立即刷新」这个动作型面板
  prompts: '提示词库',
  auth: '注册与登录',
  security: '会话与安全',
  danger: '危险区',
  data: '数据位置（只读）',
}

/** 显示顺序。⚠️ 不含 `danger` —— 危险区是在这些分区之后**单独追加**的 Tab。 */
export const GROUP_ORDER: AdminSettingItem['group'][] = [
  'generation',
  'credits',
  'payment',
  'mailer',
  'llm',
  'storage',
  'prompts',
  'auth',
  'security',
  'data',
]
