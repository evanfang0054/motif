import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'
import prettier from 'eslint-config-prettier/flat'

/**
 * 全仓唯一的 ESLint 配置（flat config）。
 *
 * 顺序不能动（三条不变量）：
 * 1. `...nextVitals` 必须在 `...nextTs` 之前。前者带的是 Babel parser
 *    （`babelOptions.presets: ['next/babel']`，而 Babel 按 **cwd** 解析 preset）；
 *    后者里的 typescript-eslint base 没有 `files` 限制，会把 parser 覆盖成 TS parser ——
 *    于是 `next/babel` 永远不会被真正调用。顺序反过来就会从仓库根解析 `next/babel` 失败
 *    （next 只装在 apps/web 下，根 node_modules 里没有）。
 * 2. `prettier` 必须放最后：它只做一件事 —— 关掉与 Prettier 冲突的格式类规则。
 * 3. `next lint` 在 Next 16 已被移除，本仓一律用 `eslint` CLI（见根 package.json 的 lint 脚本）。
 */
export default defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  {
    // 本仓是 App Router 单一形态（没有 pages/ 目录），而这条规则只为 pages 路由服务。
    // 找不到 pages 目录时它会打印「Pages directory cannot be found at ...」噪声，直接关掉。
    rules: { '@next/next/no-html-link-for-pages': 'off' },
  },
  {
    // react-hooks v7 随 React Compiler 引入了这批新规则，它们比本仓的写法新。
    // set-state-in-effect 在本仓命中 21 处，全部是「取数 + 同步置 loading」这一既有写法
    // （`useEffect(() => { void load() }, [load])`，load 首行 setLoading(true)）。
    // 正统修法是把「显示 loading」的职责从 effect 挪到触发刷新的交互回调（搜索框 onChange /
    // 分页 / 筛选），属于行为层改动、会落到 10 个页面的交互代码上 —— 故本次先降级为 warn 留痕，
    // 待专门的重构批次处理，不在「引入 lint 工具」这一次里做。
    rules: { 'react-hooks/set-state-in-effect': 'warn' },
  },
  globalIgnores([
    // 注意：flat config 的 ignores 是**相对配置文件所在目录**的 glob，所以嵌套产物必须写成
    // `**/.next/**`。只写 `.next/**` 匹配不到 apps/web/.next，会把 Turbopack 产物当源码 lint
    // （实测 4 万+ 条噪声）。另外 ESLint **不读 .gitignore**，下列目录都得显式列出。
    '**/.next/**',
    '**/out/**',
    '**/build/**',
    '**/dist/**',
    '**/node_modules/**',
    '**/.turbo/**',
    // 运行时数据
    '**/.data/**',
    '**/.data-e2e/**',
    '**/.data-accept/**',
    '**/data/**',
    // 工具生成 / 不入 git 的本地内容（只被全局 gitignore 覆盖，必须显式忽略）
    '**/.heroui-docs/**',
    '**/.infinite-canvas-ref/**',
    '**/.agents/**',
    '**/.agent-harness/**',
    '**/.vscode/**',
    '**/docs/agent-harness/**',
    '**/dogfood-output/**',
    '**/dsh-image-gen/**',
    // 类型声明产物
    '**/next-env.d.ts',
  ]),
])
