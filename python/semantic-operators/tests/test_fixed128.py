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
    asyncio.run(collect(learned_filter(rt, 'synthetic predicate', require_source=False)))
    assert updates[-1]['teacher_unique_records'] == 128
    assert updates[-1]['training_records'] == 128
    assert updates[-1]['sampling_method'] == 'ranked_top128'
    assert updates[-1]['candidate_models'] == ['dense_lr', 'dense_svm', 'dense_mlp', 'dense_hgb', 'feedback_margin', 'relation_logistic']
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
    run(rt)
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
    assert len(predicted) == 512 and set(predicted.values()) == {0}
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
