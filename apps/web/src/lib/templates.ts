/**
 * 表单的尺寸预设。
 *
 * ⚠️ 原先这里的 8 个模板已**并入提示词库**成为「系统自带」条目（用户裁决 2026-09-21），
 * 定义搬到 `lib/prompt-builtins.ts`；模板预览图仍在 `public/templates/`。
 * 选中它们只填提示词（不再连张数与尺寸一起填 —— 明确接受的能力取舍）。
 */

export const SIZE_PRESETS = [
  { key: '1024x1024', label: '方图', hint: '1024×1024' },
  { key: '1024x1536', label: '竖图', hint: '1024×1536' },
  { key: '1536x1024', label: '横图', hint: '1536×1024' },
] as const
