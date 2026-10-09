import { RetrievalError, type CandidateExportBinding, type RetrievalState } from '@retrieval-agent/contracts'
import type { MySqlTaskStore } from '@retrieval-agent/agent-plugin'

/** These versions come from durable task state, never export request parameters. */
export async function trustedExportBinding(
  tasks: Pick<MySqlTaskStore, 'read'>, state: RetrievalState, resultRevision: string,
  expected?: CandidateExportBinding,
): Promise<CandidateExportBinding> {
  const task = await tasks.read(state.retrievalId), current = task?.state_json
  const semanticGeneration = current?.inputGeneration ?? 0
  if (!task || !current || task.id !== state.retrievalId || current.retrievalId !== state.retrievalId
    || !Number.isSafeInteger(task.input_revision) || task.input_revision < 0
    || !Number.isSafeInteger(semanticGeneration) || semanticGeneration < 0
    || semanticGeneration !== (state.inputGeneration ?? 0)
    || (current.frozenEvidence?.packId ?? current.stateId) !== resultRevision
    || (state.frozenEvidence?.packId ?? state.stateId) !== resultRevision
    || current.snapshot?.snapshotId !== state.snapshot?.snapshotId) {
    throw new RetrievalError('INVALID_TRANSITION', '任务输入或语义结果版本已变化，请刷新后重新生成。')
  }
  const binding: CandidateExportBinding = { taskId: task.id, inputRevision: task.input_revision,
    semanticGeneration, resultRevision }
  if (expected) assertMatchingExportBinding(binding, expected)
  return binding
}

/** Saved JSON is untrusted until all four binding fields match the authoritative read. */
export function assertMatchingExportBinding(actual: CandidateExportBinding, expected: unknown): void {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    throw new RetrievalError('INVALID_TRANSITION', '保存工件缺少任务输入版本绑定，请重新生成。')
  }
  const value = expected as Record<string, unknown>
  if (value.taskId !== actual.taskId || value.inputRevision !== actual.inputRevision
    || value.semanticGeneration !== actual.semanticGeneration || value.resultRevision !== actual.resultRevision
    || typeof value.inputRevision !== 'number' || !Number.isSafeInteger(value.inputRevision)
    || typeof value.semanticGeneration !== 'number' || !Number.isSafeInteger(value.semanticGeneration)) {
    throw new RetrievalError('INVALID_TRANSITION', '保存工件与当前任务输入或语义结果版本不一致，请重新生成。')
  }
}
