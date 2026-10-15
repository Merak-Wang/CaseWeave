import { RetrievalError } from '@retrieval-agent/contracts'

/** 有效选择指标达到最低查准率后，模型预测才进入确认集合。 */
export function assertLearnedResultAdmission(value: unknown, metadata: unknown): void {
  const quality = value as Record<string, unknown> | undefined
  const model = metadata as Record<string, unknown> | undefined
  if (!quality || !model || !['selection', 'training_group_crossfit', 'teacher_single_class', 'unmeasured'].includes(String(quality.basis))
    || typeof model.threshold !== 'number' || !Number.isFinite(model.threshold))
    throw new RetrievalError('INVALID_REQUEST', '数值结果缺少有效模型或质量说明。')
  if (quality.basis !== 'unmeasured' && (quality.basis === 'teacher_single_class'
    || typeof quality.precision !== 'number' || !Number.isFinite(quality.precision) || quality.precision < .6
    || quality.acceptance === 'unknown' || quality.coverage !== undefined && quality.coverage !== 1))
    throw new RetrievalError('INVALID_REQUEST', '模型选择依据不足或查准率低于 60%，仅交付已确认工单。')
}
