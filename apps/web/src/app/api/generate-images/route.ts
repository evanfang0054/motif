import { NextRequest, NextResponse } from 'next/server'
import { getRuntime } from '@/server/context'
import { jsonError, readJson, requireUser } from '@/server/http'
import { enqueueGeneration } from '@/server/services'
import { startWorker } from '@/server/worker'
import type { GenerateImagesInput } from '@motif/core'

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const user = requireUser(req)
    const body = await readJson<Partial<GenerateImagesInput>>(req)
    const input: GenerateImagesInput = {
      prompt: body.prompt ?? '',
      count: Number(body.count ?? 1),
      size: body.size ?? '1024x1024',
      enhance: !!body.enhance,
      topicId: body.topicId ?? null,
      referenceCanvasImageIds: body.referenceCanvasImageIds ?? [],
    }
    const { store, provider, dataDir } = getRuntime()
    const result = await enqueueGeneration(store, provider, dataDir, user, input)
    // 有排队任务后确保 worker 在运行
    startWorker()
    return NextResponse.json(result, { status: 202 })
  } catch (e) {
    return jsonError(e)
  }
}
