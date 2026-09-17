/** 生图 Provider 抽象 —— 唯一实现：OpenAICompatProvider（gpt-image 系网关） */

export interface GeneratedImage {
  buffer: Buffer
  mimeType: string
  width: number
  height: number
}

export interface GenerateRequest {
  prompt: string
  size: string
  seedText: string
  /** 参考图（图生图 edits 输入）；为空则走文生图 */
  referenceImages: Array<{ buffer: Buffer; mimeType: string }>
  indexInBatch: number
}

export interface ImageProvider {
  readonly name: string
  generate(req: GenerateRequest): Promise<GeneratedImage>
}
