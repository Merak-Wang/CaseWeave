import { RetrievalError, type RetrievalCandidateJudgment, type RetrievalState } from '@retrieval-agent/contracts'

/** Checks condition identity and the model's own logical consistency, never business meaning. */
export function validateExclusionChecks(state: RetrievalState, judgment: RetrievalCandidateJudgment): void {
  const requirements = state.query?.spec?.queryPlan?.requirements.filter(r => r.kind === 'semantic' && r.polarity === 'exclude') ?? []
  const checked = new Set<string>()
  for (const check of judgment.exclusionChecks ?? []) {
    const requirement = requirements.find(r => r.id === check.requirementId)
    if (!requirement || check.sourceText !== requirement.span.text || checked.has(check.requirementId)) {
      throw new RetrievalError('INVALID_REQUEST', 'exclusion_checks 必须按当前 queryPlan 的 requirement_id 与完整原条件 source_text 一一对应，不能遗漏或改写或/且、对象或时序。')
    }
    checked.add(check.requirementId)
    if (!['yes', 'no', 'uncertain'].includes(check.applies) || !check.reason.trim() || check.reason.length > 1000
      || !check.evidenceRefs.length || check.evidenceRefs.some(ref => !judgment.evidenceRefs.includes(ref))) {
      throw new RetrievalError('INVALID_REQUEST', '排除条件核对需要 applies=yes/no/uncertain、简短事实理由，以及本条 judgment 已引用的可见证据。')
    }
    if (judgment.verdict === 'accept' && check.applies !== 'no') {
      throw new RetrievalError('INVALID_REQUEST', '模型判断排除条件成立或尚不确定时不能 accept；请依据原条件和可见证据决定 exclude 或 undetermined，不要只为通过校验改写 applies。')
    }
  }
  const missing = requirements.filter(r => !checked.has(r.id))
  if (judgment.verdict === 'accept' && missing.length) throw new RetrievalError('INVALID_REQUEST',
    `accept 前需要 exclusion_checks 核对明确排除项：${missing.map(r => `${r.id}=${r.span.text}`).join('；')}。每项填写 requirement_id、完整 source_text、applies=yes/no/uncertain、reason、evidence_aliases；逐一判断或分支，不能用相似纳入特征覆盖排除。有效证据无需重读。`)
}
