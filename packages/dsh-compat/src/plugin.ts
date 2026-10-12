import { installDshSessionCompatibility } from './session-events.js'
import type { Context } from '@deepseek-ai/cordis'
import { installDshCjsResolutionCompatibility } from './cjs-resolution.js'

export const name = 'retrieval-dsh-session-compat'

/** Startup entry: persistence validates stored events before any preset composes, so the RetrievalAgentService constructor runs too late for cold resume and history. */
export function apply(ctx: Context): void {
  ctx.effect(() => installDshCjsResolutionCompatibility())
  installDshSessionCompatibility()
}
