# Motif 品牌资产

## 概念：「Motif 印章」

Motif 本义是「母题/纹样」。Logo 把 **一笔手绘的珊瑚色 M** 作为母版，
四周的 **四角对位角标**（registration mark，取自印刷打样工艺）与 **上星下点** 
构成一枚盖在暖米纸上的印章——呼应产品主线「一张参考图 → 成套出图」：
M 是母题，其余元素是它的版面变奏。

## 文件清单

| 文件 | 用途 |
| --- | --- |
| `motif-logo-editorial.svg` | 完整纹样版：在 icon 基础上增加左右中线短划 + 两个墨色小「m」变奏（母题的衍生体）。适合落地页插画、OG 分享图、文档封面等 ≥64px 场景 |
| `motif-logo-512.png` | 正式 icon 的 512px 位图导出，README / OG 图直接可用 |
| `motif-banner.png` | 1200×630 品牌横幅（印章 + 字标 + 中文标语），README 顶部展示用，与 `apps/web/src/app/opengraph-image.png` 同源 |

## 分层使用约定

小「m」变奏笔画在 64 viewBox 中仅 1.7px，等比缩小到 28px 以下会糊成噪点，
因此 Logo 按「画幅大小」分两层：

| 层 | 图形 | 使用位置 |
| --- | --- | --- |
| 减法版 | 纸底 + 四角角标 + 上星下点 + 母题 M | favicon（`apps/web/src/app/icon.svg`）、顶栏等 22–28px 小尺寸（`BrandMark.tsx`） |
| 完整版 | 减法版 + 左右对位短划 + 两个墨色小「m」 | 落地页 CTA 收尾章（`public/brand/motif-logo-editorial.svg`，96px）、OG 分享图（`apps/web/src/app/opengraph-image.png`，1200×630） |

**两个文件必须保持同一视觉，改动请同步。**

## 用色（与 DESIGN.md 一致）

| 色值 | 用途 |
| --- | --- |
| `#faf9f5` | 暖米纸底（canvas） |
| `#cc785c` | 珊瑚：母题 M、角标、星点（primary） |
| `#141413` | 墨色：完整版的小 m 变奏（ink） |

暗色主题下不做反色：米色块在暖暗底上自然呈现「贴纸/印章」质感。
