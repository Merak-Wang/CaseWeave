import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ProductHeaderExport } from './HeaderExport.js'

export const inject = ['slots']

/** Keep the native DSH shell and add only the product-owned export utility. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.session.header.utilities', function* () {
    yield ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'retrieval-agent-export',
      order: 100,
      label: '导出工单',
    }, ProductHeaderExport)
  })
}
