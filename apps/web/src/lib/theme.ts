/**
 * 主题三态（浅色 / 深色 / 跟随系统）的纯逻辑。
 *
 * 为什么收口到一份：同一件事有**三个执行者** ——
 * ① 首帧防闪内联脚本（`app/layout.tsx`，水合前跑，读 localStorage 决定 `data-theme`）；
 * ② 常驻层的 matchMedia 监听（`components/ThemeWatcher.tsx`，负责运行期实时跟随系统）；
 * ③ 弹层里的三态切换（`components/workspace/ThemeToggle.tsx`，只写 localStorage + 立即应用）。
 * 「默认哪个模式」「什么算深色」各写一份必然漂移（改默认值只改一处），故收口在本文件。
 *
 * ⚠️ 本文件必须保持**纯**：不碰 window / document / localStorage。
 * 它同时被服务端（layout 拼内联脚本）与客户端引用，也是单测（`environment: 'node'`）的入口 ——
 * 一旦掺进 DOM，服务端渲染与单测都会直接炸。
 */

export type ThemeMode = 'light' | 'dark' | 'system'

/** localStorage 键。改它等于让所有既有用户的选择失效，非必要不动 */
export const THEME_STORAGE_KEY = 'motif-theme'

export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system']

/** 默认浅色：不跟随系统，避免「用户没选过却被系统拖进暗色」 */
export const DEFAULT_THEME_MODE: ThemeMode = 'light'

/** 系统明暗偏好的媒体查询。监听与判定必须用同一条字符串，否则「跟随」会跟着一个假信号走 */
export const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)'

/** 三态解析：任何非法 / 缺失值都回退默认（脏 localStorage 不能把主题打坏） */
export function parseThemeMode(raw: string | null | undefined): ThemeMode {
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : DEFAULT_THEME_MODE
}

/**
 * 该模式在「系统当前偏好」下是否应落成暗色。
 * system 之外只看模式本身 —— 系统切换不该影响用户明确选过的浅色 / 深色。
 */
export function isDarkTheme(mode: ThemeMode, systemPrefersDark: boolean): boolean {
  if (mode === 'dark') return true
  if (mode === 'light') return false
  return systemPrefersDark
}

/**
 * 首帧防闪内联脚本（水合**之前**在 <head> 之后同步执行）。
 *
 * ⚠️ 必须保持成**字符串**（要喂给 `dangerouslySetInnerHTML`），且必须整段 try/catch：
 * 隐私模式下读 localStorage 会抛错，不兜住会让脚本中断、首帧先闪一下浅色再被纠正。
 * 它只负责「首帧那一瞬间」，运行期的实时跟随归常驻监听（见 ThemeWatcher）。
 */
export const THEME_INIT_SCRIPT = `(function(){try{var m=localStorage.getItem('${THEME_STORAGE_KEY}')||'${DEFAULT_THEME_MODE}';var d=m==='dark'||(m==='system'&&window.matchMedia('${DARK_MEDIA_QUERY}').matches);if(d)document.documentElement.dataset.theme='dark';else delete document.documentElement.dataset.theme}catch(e){}})()`
