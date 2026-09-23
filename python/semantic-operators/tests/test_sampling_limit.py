"""并发、续跑和命中复核共用抽样额度；低质量模型不能发布结果。"""
import asyncio
from dataclasses import replace
import numpy as np
import pytest
from caseweave_ops import ArtifactStore, invoke_rows
from caseweave_ops.filter import judge_batch
from caseweave_ops.runtime import SamplingLimitReached, Usage
from conftest import record, source, collect
from test_learning_sets import numeric_port, run


def test_concurrent_sampling_stops_at_128_and_resume_keeps_budget(make_runtime, tmp_path):
    rt = make_runtime()
    y = np.zeros(8000, dtype=np.int8)
    updates, predicted, samples = numeric_port(rt, np.ones((len(y), 2), dtype=np.float32), y)
    async def execute():
        return await collect(invoke_rows('sem_filter', rt, source([]), 'synthetic predicate',
            {'batch_size': 1, 'options': {'concurrency': 32, 'sample_size': 256}}))
    asyncio.run(execute())
    assert rt.model.calls == 128
    assert updates[-1]['stop_reason'] == 'model_unknown'
    assert updates[-1]['sampling_requests'] == 128
    assert not predicted
    previous_samples = len(samples)
    # 同查询重启服务、修改权限作用域也不能重置已用额度。
    restored = ArtifactStore(tmp_path / 'resume.sqlite')
    rt.store.db.backup(restored.db)
    rt.store = restored
    try:
        rt.scope = replace(rt.scope, authorization='auth-v2')
        asyncio.run(execute())
        assert rt.model.calls == 128 and len(samples) == previous_samples
        assert updates[-1]['next_action'] == 'return_confirmed_only'
        # 用户真正修改查询条件后使用新的代次。
        rt.scope = replace(rt.scope, input_revision=2)
        asyncio.run(execute())
        assert rt.model.calls == 256 and updates[-1]['sampling_requests'] == 128
    finally:
        restored.close()


def test_last_initial_request_cannot_accept_without_review(make_runtime):
    rt = make_runtime()
    for _ in range(127):
        ident = rt.store.begin(rt.scope.task_id, rt.scope.key, 'sem_filter', {'input_revision': rt.scope.input_revision})
        rt.store.finish(ident, 'error', Usage(), 'synthetic_failed_attempt')
    result = asyncio.run(judge_batch(rt, [record()], 'q', sampling=True))
    assert rt.model.calls == 1
    assert rt.store.sampling_calls(rt.scope) == 128
    assert result[0].label == 'undetermined' and '复核未完成' in result[0].reason
    with pytest.raises(SamplingLimitReached):
        asyncio.run(judge_batch(rt, [record('b')], 'q', sampling=True))
    assert rt.model.calls == 1


@pytest.mark.parametrize('positive_percent,expected', [(58, 'model_unknown'), (60, 'quality_fallback'), (80, 'quality_fallback')])
def test_selection_precision_floor_and_best_model_fallback(make_runtime, positive_percent, expected):
    # 所有特征相同：最佳阈值只能全选；选择集查准率等于可复算的正例占比。
    y = (np.arange(2000) % 100 < positive_percent).astype(np.int8)
    rt = make_runtime()
    updates, predicted, _ = numeric_port(rt, np.ones((len(y), 2), dtype=np.float32), y)
    run(rt, sample_size=200, selection_size=200)
    last = updates[-1]
    assert last['stop_reason'] == expected
    assert last['quality']['precision'] == pytest.approx(positive_percent / 100)
    assert last['quality']['minimum_precision'] == .6
    assert rt.model.calls <= 128
    if expected == 'model_unknown':
        assert not predicted and last['quality']['acceptance'] == 'unknown'
        assert last['message'].startswith('不知道')
    else:
        assert len(predicted) == len(y) and last['quality']['acceptance'] == 'fallback'
        selected = next(m for m in last['models'] if m['name'] == last['selected_model'])
        assert selected['f1'] == max(m['f1'] for m in last['models'])
