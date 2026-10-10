"""Synthetic invariants; no production rows, real teachers or network calls."""
import asyncio
import base64
from dataclasses import replace
from hashlib import sha256
import numpy as np
import pytest
from caseweave_ops import invoke_rows
from caseweave_ops import models
from caseweave_ops.ensemble import (GROUP_PROJECTION, group_closure, group_roles,
    select_group_crossfit, pair_vote)
from caseweave_ops.types import Record
from conftest import record, source, collect, decisions


def h(value):
    return sha256(str(value).encode()).hexdigest()


def metadata(i):
    return {"business_hash": h(f"business-{i}"), "canonical_hash": h(f"text-{i}"),
            "group_projection": GROUP_PROJECTION}


def test_nonfinite_operating_point_is_unknown_and_not_certified():
    with pytest.raises(ValueError):
        models.operating_point([1, 0], [np.nan, np.nan])
    point = models.operating_point([1, 1, 0], [np.nan, 2., 1.])
    assert point["recall"] == .5 and point["coverage"] == pytest.approx(2/3)
    assert not point["feasible_on_selection"] and point["nonfinite_scores"] == 1
    for weights in ([1, 0], [1, np.nan]):
        with pytest.raises(ValueError):
            models.operating_point([1, 0], [2., 1.], weights=weights)


def test_group_closure_is_transitive_and_roles_do_not_depend_on_page_order():
    rows = [metadata(i) for i in range(6)]
    rows[1]["business_hash"] = rows[0]["business_hash"]
    rows[2]["canonical_hash"] = rows[1]["canonical_hash"]
    rows[5] = {}
    groups = group_closure(rows)
    assert groups[0] == groups[1] == groups[2] and groups[5] is None
    roles = group_roles(range(6), rows, seed=12)
    assert roles[0] == roles[1] == roles[2] and roles[5] == "unverified"
    order = [5, 3, 1, 0, 4, 2]
    assert group_roles(order, [rows[i] for i in order], seed=12) == roles
    bad = dict(rows[0], group_projection="legacy")
    with pytest.raises(ValueError): group_closure([bad])


def test_local_group_metadata_never_enters_teacher_payload():
    row = replace(record("local"), attributes={"group_hashes": metadata(0),
        "group_projection": GROUP_PROJECTION, "business_attribute": "synthetic"})
    assert row.model_payload()["attributes"] == {"business_attribute": "synthetic"}
    assert row.identity == replace(row, attributes={}).identity


def test_nested_relation_crossfit_and_serving_state_use_training_groups_only(monkeypatch):
    groups = np.repeat(np.arange(30).astype(str), 2)
    y = np.repeat(np.arange(30) % 2, 2)
    x = np.column_stack([np.ones(len(y)), y*2-1, np.arange(len(y))])
    original_state, original_features = models.relation_state, models.relation_features
    checked = []
    def rowgroups(value): return set((np.rint(value[:, -1]/value[:, 0]).astype(int)//2).tolist())
    def state(value, labels):
        return original_state(value, labels), rowgroups(value)
    def features(value, wrapped):
        actual, training = wrapped
        assert not rowgroups(value) & training
        checked.append((rowgroups(value), training))
        return original_features(value, actual)
    monkeypatch.setattr(models, "relation_state", state)
    monkeypatch.setattr(models, "relation_features", features)
    selected, manifest = select_group_crossfit({"dense": x}, y, groups,
        methods=["relation_logistic"], fusion="single", budget_seconds=30)
    assert selected.name == "relation_logistic" and len(checked) >= 6
    assert selected.members[0].estimator.state[1] == set(range(30))
    assert not manifest["final_holdout_used_for_selection"]


def test_failed_candidate_isolated_and_single_retained_without_identical_vote_gain(monkeypatch):
    x = np.eye(2)[np.arange(80)%2]; y = np.arange(80)%2
    original = models._fit
    def fail(candidate, *args, **kwargs):
        if candidate.name == "dense_mlp": raise ArithmeticError("synthetic failure")
        return original(candidate, *args, **kwargs)
    monkeypatch.setattr(models, "_fit", fail)
    selected, manifest = select_group_crossfit({"dense": x}, y, np.arange(80).astype(str),
        methods=["dense_lr", "dense_mlp", "feedback_margin"], fusion="selective")
    assert len(selected.members) == 1 and not manifest["selected_ensemble"]
    assert manifest["candidate_failures"] == [{"name": "dense_mlp", "error": "ArithmeticError"}]
    assert not manifest["pairs"]
    np.testing.assert_array_equal(pair_vote([1, 0, -1, 1], [0, 0, 1, -1]), [1, 0, -1, -1])


def port(runtime, n=512, *, grouped=True, flipped_holdout=False):
    ids = np.arange(n); xlabels = ids%2
    x = np.eye(2, dtype=np.float32)[xlabels]
    groups = [metadata(int(i)) if grouped else {} for i in ids]
    roles = group_roles(ids, groups)
    y = np.asarray([1-xlabels[i] if flipped_holdout and roles[int(i)] == "final_holdout" else xlabels[i] for i in ids])
    updates, predictions, samples, begin = [], {}, [], []
    def block(want, cursor=None):
        want = list(map(int, want))
        return {"ids": want, "dense": base64.b64encode(x[want].astype('<f4').tobytes()).decode(),
            "dimensions": 2, "available": base64.b64encode(np.ones(len(want), dtype='u1').tobytes()).decode(),
            "feature_id": "synthetic-group-v1", "row_groups": [groups[i] for i in want],
            "scores": (n-np.asarray(want)).tolist(), "population_count": n, "next_cursor": cursor}
    async def call(method, payload):
        if method == "features.seeds": return {"ids": [], "feature_id": "synthetic-group-v1"}
        if method == "features.scan":
            start = int(payload['cursor'] or 0); end = min(n, start+payload['page_size'])
            return block(range(start, end), str(end) if end<n else None)
        if method == "features.take": return block(payload['ids'])
        if method == "rows.read":
            samples.extend(payload['ids'])
            rows = []
            for i in payload['ids']:
                row = record(str(i), text=f"synthetic unique ticket {i}").model_payload()
                row['attributes']['group_hashes'] = groups[i]
                rows.append(row)
            return {"rows": rows}
        if method == "learning.update": updates.append(payload.copy())
        elif method == "predictions.begin": begin.append(payload.copy()); predictions.clear()
        elif method == "predictions.write": predictions.update(zip(payload['ids'],payload['labels']))
        elif method == "predictions.finish": pass
        else: raise AssertionError(method)
        return {}
    def teacher(payload, request):
        assert all('group_hashes' not in row['attributes'] for row in payload['records'])
        out=decisions(payload)
        for row, source in zip(out['rows'], payload['records']):
            row['label'] = 'yes' if y[int(source['record_ref'])] else 'no'
        return out
    runtime.resources, runtime.model.handler = call, teacher
    return updates, predictions, samples, begin, groups, y


def run(runtime, **options):
    return asyncio.run(collect(invoke_rows('sem_filter', runtime, source([]), 'synthetic predicate',
        {'algorithm':'learned','scope_mode':'full','recall_scope_key':'synthetic-recall',
         'options':{'methods':['dense_lr','feedback_margin','relation_logistic'], 'fusion':'selective',
            'pool_size':256,'sample_size':128,**options}})))






def test_cancelled_window_can_resume_without_losing_completed_labels(make_runtime):
    rt=make_runtime(); updates,predicted,_,_,_,_=port(rt)
    original=rt.resources
    async def cancel(method,payload):
        result=await original(method,payload)
        if method=='learning.update' and payload.get('stop_reason')=='sampling': rt.scope.cancelled.set()
        return result
    rt.resources=cancel
    with pytest.raises(asyncio.CancelledError): run(rt)
    assert not predicted
    rt.scope.cancelled.clear(); rt.resources=original
    run(rt)
    assert any(row.get('reused_label_records',0)>0 for row in updates)
    assert updates[-1]['stop_reason']=='quality_passed'


def test_invalid_methods_rejected_before_provider_or_teacher_calls(make_runtime):
    rt=make_runtime(); calls=[]
    async def fail(method,payload): calls.append(method); raise AssertionError(method)
    rt.resources=fail
    with pytest.raises(ValueError): run(rt,methods=['unknown'])
    assert not calls and rt.model.calls==0


def test_selective_majority_requires_actual_three_model_diversity_gain(monkeypatch):
    from caseweave_ops.models import Fitted
    x = np.arange(80)[:, None].astype(float); y = (np.arange(80)%4==0).astype(int)
    class FakeScore:
        def __init__(self, name): self.name=name
        def decision_function(self, values):
            ids=values[:,0].astype(int)
            false=ids%4=={'dense_lr':1,'feedback_margin':2,'dense_svm':3}[self.name]
            return np.where((ids%4==0)|false,.8,.1)
    def fit(candidate,*args,**kwargs):
        return Fitted(candidate.name,'dense',FakeScore(candidate.name),None,.001)
    monkeypatch.setattr(models,'_fit',fit)
    selected,manifest=select_group_crossfit({'dense':x},y,np.arange(80).astype(str),
        methods=['dense_lr','feedback_margin','dense_svm'],fusion='selective')
    assert manifest['selected_ensemble'] and manifest['selection_reason']=='oof_diversity_gain'
    assert manifest['threshold_metrics_oof']['f1']==1
    assert manifest['single_baseline']['f1']<1
    scores=selected.score_views({'dense':x})
    disagreements=(np.arange(80)%4==1)|(np.arange(80)%4==2)
    assert (scores[disagreements]==1/3).all()
    assert not (scores[disagreements]>=selected.threshold).any()


def test_same_cohort_validated_snapshot_can_survive_fit_budget_stop(make_runtime):
    rt=make_runtime(); updates,predicted,_,_,_,_=port(rt,n=128)
    run(rt,pool_size=128)
    original_members=updates[-1]['selected_members']
    assert updates[-1]['stop_reason']=='quality_passed'
    run(rt,pool_size=128,fit_budget_seconds=.000001)
    assert updates[-1]['selection_reason']=='validated_same_cohort_snapshot_fallback'
    assert updates[-1]['selected_members']==original_members and len(predicted)==128


def test_wrong_numeric_group_alignment_fails_before_teacher(make_runtime):
    rt=make_runtime(); _,_,_,_,_,_=port(rt)
    original=rt.resources
    async def wrong(method,payload):
        value=await original(method,payload)
        if method=='features.scan': value['row_groups']=value['row_groups'][:-1]
        return value
    rt.resources=wrong
    with pytest.raises(ValueError): run(rt)
    assert rt.model.calls==0


def test_explicit_six_method_names_remain_available_with_optional_sparse_view():
    from scipy.sparse import csr_matrix
    from caseweave_ops.ensemble import DEFAULT_METHODS
    y=np.arange(80)%2; x=np.eye(2)[y]
    selected,manifest=select_group_crossfit({'dense':x,'sparse':csr_matrix(x)},y,np.arange(80).astype(str),
        methods=list(DEFAULT_METHODS),fusion='single')
    assert {row['name'] for row in manifest['models']}==set(DEFAULT_METHODS)
    assert selected.name in DEFAULT_METHODS
