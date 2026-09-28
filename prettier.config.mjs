/**
 * Prettier 配置。
 *
 * 风格与既有代码对齐：无分号、单引号、尾逗号 all、2 空格缩进。
 * `printWidth` 取 120 是实测把重排量压到最小的值（100 会多动 50 个文件；160/200/240 都不再减少，
 * 因为偏差是结构性的而非行宽造成的）。
 *
 * ⚠️ CSS 必须关掉 `singleQuote`：Prettier 的 `singleQuote` 会连 CSS 属性选择器一起改写，
 * 把 `[data-theme="light"]` 变成 `[data-theme='light']` —— 而
 * `apps/web/test/design-token-contrast.test.ts`（DESIGN.md 对比度守护线）正是以双引号形态
 * 匹配这两个块的，改了它测试会红。CSS 属性选择器用双引号也更合惯例。
 *
 * ⚠️ CSS 里的行尾长注释会把声明推过 printWidth，Prettier 随即把**可断行**的值（如 `var(...)`）
 * 拆成多行；而上面那个测试按行解析 CSS，拆行后取不到令牌。故 globals.css 里
 * `--focus` 这类带长注释的声明，注释一律写在**上一行**，不要写成行尾注释。
 */
const config = {
  semi: false,
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 120,
  tabWidth: 2,
  overrides: [{ files: '*.css', options: { singleQuote: false } }],
}

export default config
