import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'

export const name = 'retrieval-agent-preset'
export const inject = ['agentPresets']
export const Config = z.object({ path: z.string().required() })
interface PresetRegistry { register(definition: { id: string; name: string; description: string; order: number;
  plugins: unknown[] }): Promise<() => Promise<void>> }

/** 读取官方Loader格式的预设，保留!!js节点；包目录提供已安装peer的解析根。 */
export async function apply(ctx: Context, config: { path: string }) {
  const plugins = parse(await readFile(config.path, 'utf8'), { customTags: [{
    tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ __jsExpr: value }) }] }) as unknown[]
  const composition = ctx.extend({ baseUrl: new URL('../', import.meta.url).href })
  const dispose = await (composition.get('agentPresets') as PresetRegistry).register({ id: 'retrieval-agent', name: '只读工单检索',
    description: '基于当前数据与业务判据检索、筛选和下载工单。', order: 20,
    plugins })
  ctx.effect(() => dispose)
}
