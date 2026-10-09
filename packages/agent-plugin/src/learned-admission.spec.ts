import { describe, expect, it } from 'vitest'
import { assertLearnedResultAdmission } from './learned-admission.js'

describe('numeric collection quality is informative', () => {
  it('publishes low OOF precision without a holdout or accuracy gate', () => {
    expect(() => assertLearnedResultAdmission({ basis: 'training_group_crossfit', reference_basis: 'teacher',
      business_accuracy: 'not_measured', precision: .4, recall: .8 }, { threshold: .5,
      selected_members: ['dense_lr', 'feedback_margin', 'relation_logistic'] })).not.toThrow()
  })
  it('publishes unmeasured no-feedback without inventing accuracy', () => {
    expect(() => assertLearnedResultAdmission({ basis: 'unmeasured', business_accuracy: 'not_measured' },
      { threshold: .5, model: 'name_gmm' })).not.toThrow()
  })
  it('accepts a disclosed single-class teacher constant', () => {
    expect(() => assertLearnedResultAdmission({ basis: 'teacher_single_class', reference_basis: 'teacher' },
      { threshold: .5, model: 'teacher_constant' })).not.toThrow()
  })
  it('rejects missing quality and nonfinite model thresholds', () => {
    expect(() => assertLearnedResultAdmission(null, { threshold: .5 })).toThrow()
    expect(() => assertLearnedResultAdmission({ basis: 'unmeasured' }, { threshold: NaN })).toThrow()
  })
})
