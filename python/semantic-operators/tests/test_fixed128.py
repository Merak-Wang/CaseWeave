"""固定128工单主链：真实selector、全128fit、无复核或质量发布门槛。"""
import numpy as np
import asyncio
from test_online_fusion import port, run
from caseweave_ops import models


def test_default_online_options_use_fixed128_without_legacy_gate(make_runtime):
    from caseweave_ops.filter import learned_filter
    from conftest import collect
    rt = make_runtime()
    updates, predicted, samples, begin, _, _ = port(rt)
    original = rt.resources
    async def resources(method, payload):
        response = await original(method, payload)
        if method == 'features.scan':
            # 让高 ID 分数更高，验证默认选样跟随真实分数而非扫描顺序。
            response['scores'] = response['ids']
        return response
    rt.resources = resources
    asyncio.run(collect(learned_filter(rt, 'synthetic predicate', require_source=False)))
    assert updates[-1]['teacher_unique_records'] == 128
    assert updates[-1]['training_records'] == 128
    assert updates[-1]['sampling_method'] == 'ranked_top128'
    assert updates[-1]['training_ids'] == list(range(511, 383, -1))
    assert set(samples) == set(range(384, 512))
    from caseweave_ops.ensemble import DEFAULT_METHODS
    assert updates[-1]['candidate_models'] == [name for name in DEFAULT_METHODS
        if not (name.startswith('text_') or name == 'joint_lr')]  # 此数值Provider没有文本。
    assert updates[-1]['fusion'] == 'selective'
    assert len(predicted) == 512 and rt.model.calls == 16


def test_explicit_stratified_option_still_covers_all_rank_layers(make_runtime):
    rt = make_runtime()
    updates, predicted, samples, _, _, _ = port(rt)
    run(rt, sampling_strategy='stratified_diverse')
    chosen = updates[-1]['training_ids']
    assert updates[-1]['sampling_method'] == 'stratified_diverse'
    assert len(set(chosen)) == 128
    assert all(sum(start <= i < start + 64 for i in chosen) == 16 for start in range(0, 512, 64))
    assert set(samples) == set(chosen)
    assert len(predicted) == 512 and rt.model.calls == 16


def test_fixed_top128_all_teacher_labels_refit_and_full_scope_prediction(make_runtime, monkeypatch):
    rt = make_runtime()
    updates, predicted, samples, begin, groups, y = port(rt)
    sizes = []
    original = models._fit
    def fit(candidate, views, labels, **kwargs):
        sizes.append(len(labels))
        return original(candidate, views, labels, **kwargs)
    monkeypatch.setattr(models, '_fit', fit)
    run(rt, sampling_strategy='ranked_top128')
    assert updates[-1]['training_ids'] == list(range(128))
    assert updates[-1]['teacher_unique_records'] == 128
    assert updates[-1]['exploration_records'] == 0
    assert updates[-1]['final_holdout_records'] == 0
    assert max(sizes) == 128
    assert set(predicted) == set(range(512))
    assert set(predicted.values()) <= {0, 1}
    assert rt.model.calls == 16
    assert len(begin) == 1


def test_single_class_teacher_uses_constant_without_extra_labels(make_runtime):
    from conftest import decisions
    rt = make_runtime()
    updates, predicted, samples, begin, _, _ = port(rt)
    rt.model.handler = lambda payload, request: decisions(payload, request, label='exclude')
    run(rt)
    assert updates[-1]['training_records'] == 128
    assert updates[-1]['selected_model'] == 'teacher_constant'
    assert updates[-1]['quality']['basis'] == 'teacher_single_class'
    assert not predicted and not begin
    assert updates[-1]['stop_reason'] == 'model_unknown'
    assert updates[-1]['quality']['acceptance'] == 'unknown'
    assert rt.model.calls == 16


def test_only_teacher_labels_train_without_host_seed_import(make_runtime):
    from caseweave_ops.filter import learned_filter
    from conftest import collect
    rt = make_runtime()
    updates, _, samples, _, _, _ = port(rt)
    original = rt.resources
    async def resources(method, payload):
        assert method != "features.seeds", "Host judgments must never become training labels"
        return await original(method, payload)
    rt.resources = resources
    asyncio.run(collect(learned_filter(rt, "synthetic predicate", require_source=False)))
    assert len(samples) == 128
    assert updates[-1]["training_records"] == 128


def test_raw_ridge_margin_and_oof_threshold_publish_without_probability_clamp(make_runtime):
    from caseweave_ops.filter import learned_filter
    from conftest import collect
    rt = make_runtime()
    _, predicted, _, begin, _, _ = port(rt)
    original = rt.resources
    writes = []
    async def resources(method, payload):
        if method == "predictions.write":
            writes.append(payload)
        return await original(method, payload)
    rt.resources = resources
    asyncio.run(collect(learned_filter(rt, "synthetic predicate", require_source=False,
        options={"methods": ["dense_ridge"], "fusion": "single"})))
    assert begin[-1]["model"] == "dense_ridge"
    threshold = begin[-1]["threshold"]
    scores = {i: score for block in writes for i, score in zip(block["ids"], block["scores"])}
    assert min(scores.values()) < 0
    # 样本票沿教师保留；其余工单只按本模型OOF阈值判断，不用统一0.5。
    assert all(predicted[i] == int(score >= threshold) for i, score in scores.items() if i >= 128)
