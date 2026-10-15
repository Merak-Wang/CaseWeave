import numpy as np
from caseweave_ops.features import stratified_diverse_sample
from caseweave_ops.models import operating_point, model_bank, _fit

def test_sampling_covers_rank_layers_without_labels_and_is_order_stable():
    ids=np.arange(256);x=np.random.default_rng(0).normal(size=(256,8));scores=-ids.astype(float)
    chosen=stratified_diverse_sample(ids,x,scores,128,seed=0)
    assert len(set(chosen))==128
    assert all(sum((chosen>=a)&(chosen<a+32))==16 for a in range(0,256,32))
    np.testing.assert_array_equal(chosen,stratified_diverse_sample(ids[::-1],x[::-1],scores[::-1],128,seed=0))

def test_operating_point_prefers_feasible_target_before_ba():
    y=np.array([1,0,1,0]);score=np.array([4,3,2,1.])
    p=operating_point(y,score,precision_target=.6,recall_target=.9)
    assert p['precision']>=.6 and p['recall']>=.9 and p['feasible_on_selection']

def test_joint_linear_fits_text_vocabulary_only_on_training():
    c=model_bank(methods=['joint_lr'])[0]
    views={'dense':np.eye(4),'text':np.array(['账号异常','权限错误','普通办理','普通咨询'],dtype=object)}
    m=_fit(c,views,np.array([1,1,0,0]))
    assert np.isfinite(m.score({'dense':np.ones((1,4)),'text':np.array(['留出专用'])})).all()
    assert '专用' not in m.estimator.vectorizer.vocabulary_

def test_unavailable_group_evidence_preserves_teacher_decisions_without_predictions(make_runtime, monkeypatch):
    import caseweave_ops.online_group_filter as online
    from test_online_fusion import port, run
    rt=make_runtime();updates,predicted,samples,begin,_,_=port(rt)
    def unavailable(*args,**kwargs):
        raise ValueError('insufficient independent groups')
    monkeypatch.setattr(online,'select_group_crossfit',unavailable)
    run(rt)
    assert len(set(samples))==128 and rt.model.calls==16
    assert not predicted and not begin
    assert updates[-1]['stop_reason']=='model_unknown'
    assert updates[-1]['quality']['acceptance']=='unknown'
