import type { NumericPredictionBlock, SemanticResultStore } from '@retrieval-agent/contracts'
import type { Pool } from 'mysql2/promise'

export const SEMANTIC_RESULT_DDL = `CREATE TABLE IF NOT EXISTS ra_semantic_result (
  task_id VARCHAR(64) NOT NULL, model_id CHAR(64) NOT NULL, numeric_id BIGINT NOT NULL,
  score DOUBLE NOT NULL, PRIMARY KEY(task_id,model_id,numeric_id))`

/** 生产集合在 MySQL；一块一次批提交，任务 JSON 只保留集合句柄和质量。 */
export class MySqlSemanticResultStore implements SemanticResultStore {
  constructor(readonly pool: Pool, readonly ready: Promise<void>) {}
  async begin(_taskId: string, _modelId: string): Promise<void> { await this.ready }
  async write(taskId: string, block: NumericPredictionBlock): Promise<void> {
    await this.ready
    const accepted = block.ids.flatMap((id, i) => block.labels[i] === 1 ? [[taskId, block.model_id, id, block.scores[i]]] : [])
    if (accepted.length) await this.pool.query('INSERT INTO ra_semantic_result(task_id,model_id,numeric_id,score) VALUES ? ON DUPLICATE KEY UPDATE score=VALUES(score)', [accepted])
    // 负 offset 是有界抽验修正，普通预测块不为数千万负例写空记录。
    if (block.offset < 0) {
      const removed = block.ids.filter((_, i) => block.labels[i] !== 1)
      if (removed.length) await this.pool.query('DELETE FROM ra_semantic_result WHERE task_id=? AND model_id=? AND numeric_id IN (?)', [taskId, block.model_id, removed])
    }
  }
  async page(taskId: string, modelId: string, after: number, limit: number) {
    const [rows] = await this.pool.query('SELECT numeric_id,score FROM ra_semantic_result WHERE task_id=? AND model_id=? AND numeric_id>? ORDER BY numeric_id LIMIT ?', [taskId, modelId, after, limit])
    const values = rows as { numeric_id: number; score: number }[]
    return { ids: values.map(r => Number(r.numeric_id)), scores: values.map(r => r.score) }
  }
  async count(taskId: string, modelId: string): Promise<number> {
    const [rows] = await this.pool.query('SELECT COUNT(*) n FROM ra_semantic_result WHERE task_id=? AND model_id=?', [taskId, modelId])
    return Number((rows as { n: number }[])[0]!.n)
  }
}

/** 非持久 DSH 示例会话使用；正式任务通过同一接口接 MySQL。 */
export class MemorySemanticResultStore implements SemanticResultStore {
  private readonly sets = new Map<string, Map<number, number>>()
  async begin(taskId: string, modelId: string) { this.sets.set(`${taskId}:${modelId}`, new Map()) }
  async write(taskId: string, block: NumericPredictionBlock) {
    const rows = this.sets.get(`${taskId}:${block.model_id}`)!
    block.ids.forEach((id, i) => { if (block.labels[i] === 1) rows.set(id, block.scores[i]!); else if (block.offset < 0) rows.delete(id) })
  }
  async page(taskId: string, modelId: string, after: number, limit: number) {
    const rows = this.sets.get(`${taskId}:${modelId}`)!
    const ids = [...rows.keys()].filter(id => id > after).sort((a, b) => a-b).slice(0, limit)
    return { ids, scores: ids.map(id => rows.get(id)!) }
  }
  async count(taskId: string, modelId: string) { return this.sets.get(`${taskId}:${modelId}`)!.size }
}
