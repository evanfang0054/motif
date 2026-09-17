/** 模板定义 —— 全部为原创文案与原创提示词 */

export interface TemplateDef {
  key: string
  title: string
  desc: string
  preview: string
  needsReference: boolean
  count: number
  size: string
  sizeLabel: string
  prompt: string
}

export const SIZE_PRESETS = [
  { key: '1024x1024', label: '方图', hint: '1024×1024' },
  { key: '1024x1536', label: '竖图', hint: '1024×1536' },
  { key: '1536x1024', label: '横图', hint: '1536×1024' },
] as const

function suitePrompt(theme: string, roles: string): string {
  return (
    `以用户上传的参考图为核心主体，围绕「${theme}」策划一组可直接商用的图片。` +
    `先识别参考图中主体的类别、形态、颜色、材质与关键特征，并在整组图片中严格保持主体一致，不得替换或改动主体本身。` +
    `每张图片独立成画：不拼图、不加水印文字、不变形。` +
    `按张数在以下方向中自动分配且互不重复：${roles}。` +
    `整体质感要求：真实摄影感、构图干净、光线自然高级、主体占比舒适。`
  )
}

function portraitPrompt(theme: string, scenes: string): string {
  return (
    `以用户上传的人像照片为唯一形象依据，围绕「${theme}」生成一组人像写真。` +
    `保持面容与体型和参考图完全一致：不美化到失真、不改变年龄与性别特征、不生成额外人物。` +
    `每张独立成图，不拼图、不添加文字水印。` +
    `按张数在以下场景与机位中自动分配且互不重复：${scenes}。` +
    `整体要求：皮肤与材质细节真实、光线有层次、景深自然、成片可直接用于社交与印刷。`
  )
}

export const TEMPLATES: TemplateDef[] = [
  {
    key: 'ecommerce-suite',
    title: '电商商品全套图',
    desc: '上传商品照，一次产出白底主图、使用场景与细节特写，覆盖上新、详情页与投放素材。',
    preview: '/templates/ecommerce-suite.svg',
    needsReference: true,
    count: 8,
    size: '1024x1024',
    sizeLabel: '方图',
    prompt: suitePrompt('商品电商套图', '纯色底主图、生活方式场景、材质微距、开箱视角、卖点氛围、季节活动图、社媒方图、广告横图'),
  },
  {
    key: 'world-landmarks',
    title: '环球地标旅拍',
    desc: '上传人像，生成多座城市地标前的旅行大片，适配社交封面与生活方式内容。',
    preview: '/templates/world-landmarks.svg',
    needsReference: true,
    count: 6,
    size: '1024x1536',
    sizeLabel: '竖图',
    prompt: portraitPrompt('环球地标旅拍', '不同城市地标的日景与夜景、街拍视角、广角环境人像、逆光剪影、标志性建筑前景虚化'),
  },
  {
    key: 'portrait-editorial',
    title: '个人形象写真',
    desc: '上传人像，产出头像、职业照与个人品牌封面，适合简历、主页与账号包装。',
    preview: '/templates/portrait-editorial.svg',
    needsReference: true,
    count: 8,
    size: '1024x1536',
    sizeLabel: '竖图',
    prompt: portraitPrompt('个人形象写真', '纯色背景头像、商务半身照、杂志感封面、窗光肖像、黑白质感、低饱和影调'),
  },
  {
    key: 'wedding-portrait',
    title: '婚纱旅拍样片',
    desc: '上传情侣或个人照，生成婚礼样片与纪念相册素材，呈现仪式感与旅行感。',
    preview: '/templates/wedding-portrait.svg',
    needsReference: true,
    count: 8,
    size: '1024x1536',
    sizeLabel: '竖图',
    prompt: portraitPrompt('婚纱旅拍样片', '白纱仪式感正面照、海边落日剪影、城市街景拥抱、教堂光影、花田远景、相册扉页构图'),
  },
  {
    key: 'senior-portrait',
    title: '长辈纪念写真',
    desc: '上传长辈照片，生成端庄棚拍与节日祝福肖像，适合装裱与家庭留念。',
    preview: '/templates/senior-portrait.svg',
    needsReference: true,
    count: 8,
    size: '1024x1536',
    sizeLabel: '竖图',
    prompt: portraitPrompt('长辈纪念写真', '端庄棚拍半身像、暖色家庭环境、节庆服饰肖像、书法背景合影位、柔和伦勃朗光'),
  },
  {
    key: 'men-editorial',
    title: '男士商务大片',
    desc: '上传男性照片，产出商务精英与都市电影感人像，适合职场展示与个人 IP。',
    preview: '/templates/men-editorial.svg',
    needsReference: true,
    count: 8,
    size: '1024x1536',
    sizeLabel: '竖图',
    prompt: portraitPrompt('男士商务大片', '西装商务照、城市夜景电影感、机车街头风、极简影棚硬光、低角度全景'),
  },
  {
    key: 'women-elegant',
    title: '女士轻奢大片',
    desc: '上传女性照片，生成轻奢棚拍与杂志封面感人像，适配个人品牌与内容封面。',
    preview: '/templates/women-elegant.svg',
    needsReference: true,
    count: 8,
    size: '1024x1536',
    sizeLabel: '竖图',
    prompt: portraitPrompt('女士轻奢大片', '礼服影棚照、杂志封面构图、柔光特写、长裙旋转动感、落地窗逆光'),
  },
  {
    key: 'kids-series',
    title: '儿童成长影像',
    desc: '上传儿童照片，生成生日纪念与亲子记录，适合相册定制与家庭分享。',
    preview: '/templates/kids-series.svg',
    needsReference: true,
    count: 8,
    size: '1024x1536',
    sizeLabel: '竖图',
    prompt: portraitPrompt('儿童成长影像', '生日蛋糕场景、户外草地奔跑、亲子互动、节日主题装扮、奶油色系棚拍'),
  },
]
