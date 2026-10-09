import { RetrievalError } from '@retrieval-agent/contracts'

/** 指标描述效果，不设发布门槛；集合仍须属于当前实际数值模型。 */
export function assertLearnedResultAdmission(value: unknown, metadata: unknown): void {
  const quality = value as Record<string, unknown> | undefined
  const model = metadata as Record<string, unknown> | undefined
  if (!quality || !model || !['selection', 'training_group_crossfit', 'teacher_single_class', 'unmeasured'].includes(String(quality.basis))
    || typeof model.threshold !== 'number' || !Number.isFinite(model.threshold))
    throw new RetrievalError('INVALID_REQUEST', '数值结果缺少有效模型或质量说明。')
}
