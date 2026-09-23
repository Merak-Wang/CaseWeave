import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-token-meter'
import * as SessionStats from '@deepseek-ai/dsh-session-stats'
import type { RuntimeMetrics } from '@retrieval-agent/contracts'

export async function installSessionMetrics(ctx: Context): Promise<void> {
  await ctx.plugin(SessionStats)
}

/** 与官方界面读取相同投影；历史分页、压缩都不清零累计用量与耗时。 */
export function sessionMetrics(ctx: Context, session: Session): RuntimeMetrics {
  const values = ctx.get('sessionProjections')?.snapshot(session,
    ['tokenUsage', 'sessionStats', 'contextPressure', 'contextBreakdown']).values ?? {}
  return { ...values }
}
