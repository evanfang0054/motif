/** 额度结算规则：1 张图片 = 1 额度；取消/失败按未完成张数退回 */

export function costFor(count: number): number {
  return count
}

export function refundFor(requestedCount: number, completedCount: number): number {
  if (completedCount < 0) completedCount = 0
  const refund = requestedCount - completedCount
  return refund > 0 ? refund : 0
}

/** 注册赠送额度 */
export const SIGNUP_BONUS_CREDITS = 3

/** 邀请奖励：每成功邀请 1 人得 3 张，最多 3 人 */
export const INVITE_REWARD_CREDITS = 3
export const INVITE_REWARD_MAX_INVITEES = 3

export function inviteRewardFor(invitedCountBefore: number): number {
  if (invitedCountBefore >= INVITE_REWARD_MAX_INVITEES) return 0
  return INVITE_REWARD_CREDITS
}
