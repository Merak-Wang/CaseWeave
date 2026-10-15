"""固定排序前128伪标签；并集预测、重启复用和条件修订仍沿真实算子。"""
import asyncio
from dataclasses import replace
import pytest
from caseweave_ops import ArtifactStore
from caseweave_ops.types import ProtocolError
from conftest import decisions
from test_online_fusion import port,run


def test_concurrent_sampling_fixed_top128_and_resume_preserves_labels(make_runtime):
    rt=make_runtime(); updates,predicted,samples,_,_,_=port(rt,n=512)
    run(rt,sample_size=256,concurrency=32)
    assert rt.model.calls==16
    assert updates[-1]['sampling_record_limit']==128 and updates[-1]['sampling_requests']==16
    training_ids=set(updates[-1]['training_ids'])
    assert len(training_ids)==128 and len(predicted)==512
    assert set(samples)==training_ids
    assert training_ids==set(range(128))  # 默认只选真实排序分最高128条。
    restored=ArtifactStore(':memory:'); rt.store.db.backup(restored.db); rt.store=restored
    try:
        run(rt,sample_size=256,concurrency=32)
        assert rt.model.calls==16 and len(predicted)==512
        assert any(u.get('reused_label_records')==128 for u in updates)
        rt.scope=replace(rt.scope,input_revision=2)
        run(rt,sample_size=256,concurrency=32)
        assert rt.model.calls==32 and updates[-1]['sampling_requests']==16
        assert set(updates[-1]['training_ids'])==training_ids
    finally: restored.close()


def test_technical_unknown_does_not_become_no_or_expand_sampling(make_runtime):
    rt=make_runtime(); updates,predicted,samples,_,_,_=port(rt,n=512)
    rt.model.handler=lambda p,r:{'rows':[]}
    with pytest.raises(ProtocolError,match='Teacher execution failed for fixed top128'): run(rt)
    assert rt.model.calls==16 and not predicted
    assert len(set(samples))==128 and updates[-1]['training_records']==0
    # 失败以异常返回；最后一条宿主进度仍是采样，不能冒充成功交付。
    assert updates[-1]['stop_reason']=='sampling' and updates[-1]['undetermined_records']==128


@pytest.mark.parametrize('positive_percent',[58,60,80])
def test_low_precision_oof_returns_unknown_without_publishing(make_runtime,positive_percent):
    rt=make_runtime(); updates,predicted,_,_,_,_=port(rt,n=512)
    def teacher(p,r):
        out=decisions(p,r)
        for item,record in zip(out['rows'],p['records']):
            item['label']='yes' if int(record['record_ref'])%100<positive_percent else 'no'
        return out
    rt.model.handler=teacher
    run(rt,methods=['dense_lr'])
    last=updates[-1]
    assert last['training_records']==128 and last['selection_records']==0
    assert last['quality']['reference_basis']=='teacher' and last['quality']['business_accuracy']=='not_measured'
    if last['quality']['precision']<.60:
        assert not predicted and last['stop_reason']=='model_unknown'
        assert last['quality']['acceptance']=='unknown'
    else:
        assert len(predicted)==512 and last['quality']['acceptance'] in {'target','fallback'}
    assert last['quality']['precision_floor']==.60 and last['next_action']=='return_confirmed_results'
