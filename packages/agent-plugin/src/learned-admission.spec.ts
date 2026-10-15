import { describe, expect, it } from 'vitest'
import { assertLearnedResultAdmission } from './learned-admission.js'

describe('numeric collection quality admission', () => {
  it('rejects predictions below the selection precision floor', () => {
    expect(() => assertLearnedResultAdmission({ basis: 'training_group_crossfit', reference_basis: 'teacher',
      business_accuracy: 'not_measured', precision: .4, recall: .8 }, { threshold: .5,
      selected_members: ['dense_lr', 'feedback_margin', 'relation_logistic'] })).toThrow()
  })
  it('publishes unmeasured no-feedback without inventing accuracy', () => {
    expect(() => assertLearnedResultAdmission({ basis: 'unmeasured', business_accuracy: 'not_measured' },
      { threshold: .5, model: 'name_gmm' })).not.toThrow()
  })
  it('rejects a single-class fit as evidence for unseen predictions', () => {
    expect(() => assertLearnedResultAdmission({ basis: 'teacher_single_class', reference_basis: 'teacher' },
      { threshold: .5, model: 'teacher_constant' })).toThrow()
  })
  it('admits the best measured fallback and rejects unknown selection evidence', () => {
    const model = { threshold: .5, selected_members: ['dense_lr'] }
    expect(() => assertLearnedResultAdmission({ basis: 'training_group_crossfit', precision: .6,
      recall: .8, acceptance: 'fallback', coverage: 1 }, model)).not.toThrow()
    expect(() => assertLearnedResultAdmission({ basis: 'training_group_crossfit', precision: .9,
      recall: .8, acceptance: 'unknown', coverage: 1 }, model)).toThrow()
  })
  it('rejects missing quality and nonfinite model thresholds', () => {
    expect(() => assertLearnedResultAdmission(null, { threshold: .5 })).toThrow()
    expect(() => assertLearnedResultAdmission({ basis: 'unmeasured' }, { threshold: NaN })).toThrow()
  })
})
