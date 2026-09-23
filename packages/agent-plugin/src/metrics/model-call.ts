import type { Context } from '@deepseek-ai/cordis'
import { AssistantStreamAccumulator, BlockAssembler, createAssistantMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, canonicalHeader } from '@deepseek-ai/dsh-session'
import { sessionMetrics } from './session.js'

/** 每个请求独立折叠官方 DSH 事件；读数进入已有任务回执，不污染主会话窗口。 */
export class ModelCallMetrics {
  private readonly session: Session
  private readonly stream = new AssistantStreamAccumulator()
  private readonly assembler = new BlockAssembler()
  constructor(private readonly ctx: Context, private readonly request: GenerateOptions, contextWindow: number) {
    this.session = Session.create(request.sessionId!)
    this.session.append('request/header', { header: canonicalHeader({ config: { provider: request.provider, model: request.model } }), reason: 'initial' })
    this.session.append('request/context', { provider: request.provider, model: request.model, contextWindow })
    this.session.append('turn/start', { turn: 0 })
    this.session.append('step/start', { turn: 0, step: 0 })
  }
  push(chunk: StreamChunk): void {
    this.stream.push({ time: Date.now(), chunk })
    this.assembler.push(chunk)
  }
  finish(completed: boolean) {
    const stream = [...this.stream.snapshot()]
    if (completed) this.session.append('assistant/message', { turn: 0, step: 0, stream,
      message: createAssistantMessage({ content: this.assembler.blocks(), source: { provider: this.request.provider, model: this.request.model } }),
      ...(this.assembler.usage ? { usage: this.assembler.usage } : {}) }, { surfaceOp: 'append' })
    else this.session.append('assistant/attempt', { turn: 0, step: 0, stream })
    this.session.append('step/end', { turn: 0, step: 0 })
    // 此处只交付单次调用的用量和时间；真实上下文占用由原 Session 独立投影。
    const { tokenUsage, sessionStats } = sessionMetrics(this.ctx, this.session)
    return { ...(tokenUsage ? { tokenUsage } : {}), ...(sessionStats ? { sessionStats } : {}) }
  }
}
