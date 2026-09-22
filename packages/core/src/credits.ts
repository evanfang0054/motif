/** 额度结算规则：1 张图片 = 1 额度；取消/失败按未完成张数退回 */

export function costFor(count: number): number {
  return count
}

export function refundFor(requestedCount: number, completedCount: number): number {
  if (completedCount < 0) completedCount = 0
  const refund = requestedCount - completedCount
  return refund > 0 ? refund : 0
}

/**
 * 额度赠送的**默认值**。
 *
 * ⚠️ 这三项已改为可在管理后台「系统设置」的「额度与奖励」分组里配置，
 * 此处只是「键未设置时的兜底」与单测的基准，**不是运行时的唯一真相**。
 * 运行时取值由服务端读配置后作为规则对象传进来（见 inviteRewardFor 的 rules 参数）。
 */
export const DEFAULT_SIGNUP_BONUS_CREDITS = 3
export const DEFAULT_INVITE_REWARD_CREDITS = 3
export const DEFAULT_INVITE_REWARD_MAX_INVITEES = 3

/** 邀请奖励规则（由配置注入，故 core 保持零配置依赖） */
export interface InviteRewardRules {
  credits: number
  maxInvitees: number
}

/**
 * 计算本次邀请应发多少额度。
 * `invitedCountBefore` 是邀请人**在此之前**已成功邀请的人数（上限按它判）。
 * 活动关闭时调用方**根本不调用本函数**（关闭即不建立邀请关系），故这里不设 enabled 参数。
 */
export function inviteRewardFor(
  invitedCountBefore: number,
  rules: InviteRewardRules = {
    credits: DEFAULT_INVITE_REWARD_CREDITS,
    maxInvitees: DEFAULT_INVITE_REWARD_MAX_INVITEES,
  }
): number {
  if (invitedCountBefore >= rules.maxInvitees) return 0
  return rules.credits
}

/** @deprecated 旧名保留以免一次性改动所有引用点；运行时取值请走配置 */
export const SIGNUP_BONUS_CREDITS = DEFAULT_SIGNUP_BONUS_CREDITS
/** @deprecated 同上 */
export const INVITE_REWARD_CREDITS = DEFAULT_INVITE_REWARD_CREDITS
/** @deprecated 同上 */
export const INVITE_REWARD_MAX_INVITEES = DEFAULT_INVITE_REWARD_MAX_INVITEES
