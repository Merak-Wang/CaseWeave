"""Real Runtime consumer tests with synthetic features and source records only."""
import asyncio
import base64

import numpy as np
import pytest

from caseweave_ops.types import ProtocolError, StaleTask
from caseweave_ops import invoke_rows
from caseweave_ops.unlabeled import QueryUnlabeledAdapter
import caseweave_ops.unlabeled_filter as module
from caseweave_ops.unlabeled_filter import unlabeled_filter
from conftest import collect, record, source


class SyntheticPort:
    def __init__(self, runtime, X, *, order=None, missing=(), changed=(), generated=(), extra_required=()):
        self.runtime, self.X = runtime, np.asarray(X, dtype=np.float32)
        self.order = list(range(len(X))) if order is None else list(order)
        self.missing, self.changed, self.generated, self.extra_required = set(missing), set(changed), set(generated), set(extra_required)
        self.read_counts, self.calls, self.updates = {}, [], []
        self.active = self.max_active = 0
        self.page_hook = self.anchor_hook = self.read_hook = None
        runtime.resources = self

    async def __call__(self, method, p):
        self.calls.append((method, p.copy()))
        if method == "features.scan":
            start, width = int(p["cursor"] or 0), p["page_size"]
            end = min(len(self.order), start + width)
            ids = self.order[start:end]
            available = np.array([i not in self.missing for i in ids], dtype=np.uint8)
            page = {"ids": ids, "dense": base64.b64encode(self.X[ids].astype("<f4").tobytes()).decode(),
                "dimensions": self.X.shape[1], "available": base64.b64encode(available.tobytes()).decode(),
                "feature_id": "synthetic-features", "population_count": len(self.X),
                "next_cursor": str(end) if end < len(self.order) else None}
            return self.page_hook(page, start) if self.page_hook else page
        if method == "features.anchor":
            anchors = {"feature_id": "synthetic-features", "embedding_id": "synthetic-test-space",
                       "query_anchor": [1., 0., 0.], "negative_anchor": [-1., 0., 0.]}
            return self.anchor_hook(anchors) if self.anchor_hook else anchors
        if method == "rows.read":
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            try:
                await asyncio.sleep(0)
                rows = []
                for i in p["ids"]:
                    self.read_counts[i] = self.read_counts.get(i, 0) + 1
                    row = record(str(i), text=f"synthetic local source {i}", vector=tuple(self.X[i]),
                                 origin="generated" if i in self.generated else "source").model_payload()
                    if i in self.extra_required:
                        row["attributes"]["required_evidence_fields"] = ["missing-source-field"]
                    if i in self.changed and self.read_counts[i] > 1:
                        row["version"] = "changed-v2"
                    rows.append(row)
                result = {"ids": p["ids"], "rows": rows}
                return self.read_hook(result, p) if self.read_hook else result
            finally:
                self.active -= 1
        if method.startswith("predictions."):
            return {}
        if method == "learning.update":
            self.updates.append(p.copy()); return {}
        raise AssertionError("Unlabeled consumer called a forbidden resource: " + method)


def vectors():
    rng = np.random.default_rng(88)
    return np.vstack([rng.normal((1., 0., 0.), .12, (12, 3)), rng.normal((-1., 0., 0.), .12, (12, 3))])


def execute(rt, method="name_gmm", **kwargs):
    return asyncio.run(unlabeled_filter(rt, "synthetic explicit predicate", method=method,
        recall_scope_key="synthetic-recall-scope", **kwargs))


@pytest.mark.parametrize("method", ("dual_description_margin", "name_gmm", "kmeans"))
def test_numeric_collection_is_binary_no_teacher_no_source_hydration_and_order_invariant(make_runtime, method):
    outputs=[]
    for block_size,order in [(1,range(24)),(7,reversed(range(24))),(24,range(24))]:
        rt=make_runtime();port=SyntheticPort(rt,vectors(),order=order)
        execute(rt,method,options={"block_size":block_size,"seed":7})
        writes=[p for name,p in port.calls if name=="predictions.write"]
        labels={i:label for p in writes for i,label in zip(p["ids"],p["labels"])}
        assert len(labels)==24 and set(labels.values())=={0,1}
        assert rt.model.calls==0 and not port.read_counts
        assert not any(name=="rows.read" for name,_ in port.calls)
        begin=next(p for name,p in port.calls if name=="predictions.begin")
        finish=next(p for name,p in port.calls if name=="predictions.finish")
        assert begin["training_records"]==0 and begin["fit_count"]==(0 if method=="dual_description_margin" else 1)
        assert finish["passed"] is True and finish["scope_count"]==24
        assert finish["returned"]==sum(labels.values())
        assert finish["quality"]=={"basis":"unmeasured","business_accuracy":"not_measured"}
        final=port.updates[-1]
        assert final["stop_reason"]=="complete" and final["semantic_complete"] is True
        assert final["unresolved"]==0 and final["source_read_passes"]==0
        assert final["confirmed_records"]==sum(labels.values())
        outputs.append(labels)
    assert outputs[0]==outputs[1]==outputs[2]


def test_missing_vectors_are_technical_failure_never_negative_or_published(make_runtime):
    rt=make_runtime();port=SyntheticPort(rt,vectors(),missing=(0,))
    with pytest.raises(ProtocolError,match="missing_numeric_features"):
        execute(rt)
    assert not any(name.startswith("predictions.") for name,_ in port.calls)
    assert rt.model.calls==0 and not port.read_counts


def test_negative_description_missing_fails_without_guessing_anchor(make_runtime):
    rt=make_runtime();port=SyntheticPort(rt,vectors())
    port.anchor_hook=lambda value:{**value,"negative_anchor":None}
    with pytest.raises(ProtocolError,match="negative_description_anchor"):
        execute(rt,"dual_description_margin")
    assert not any(name=="predictions.finish" for name,_ in port.calls)


@pytest.mark.parametrize("fault",("duplicate_ids","feature_generation","population","encoding","cursor"))
def test_bad_scan_never_fits_publishes_or_calls_teacher(make_runtime,monkeypatch,fault):
    rt=make_runtime();port=SyntheticPort(rt,vectors())
    def corrupt(page,start):
        if fault=="duplicate_ids" and start:page["ids"][0]=0
        elif fault=="feature_generation" and start:page["feature_id"]="changed"
        elif fault=="population":page["population_count"]=25
        elif fault=="encoding":page["available"]=""
        elif fault=="cursor":page["next_cursor"]="0"
        return page
    port.page_hook=corrupt
    monkeypatch.setattr(module,"fit_numeric_unlabeled",lambda *a,**k:pytest.fail("invalid scan must not fit"))
    with pytest.raises((ProtocolError,StaleTask)):execute(rt,options={"block_size":4})
    assert rt.model.calls==0 and not port.read_counts
    assert not any(name.startswith("predictions.") for name,_ in port.calls)


def test_cancel_after_fit_never_publishes(make_runtime,monkeypatch):
    rt=make_runtime();port=SyntheticPort(rt,vectors())
    original=module.fit_numeric_unlabeled
    def cancel(*args,**kwargs):
        value=original(*args,**kwargs);rt.scope.cancelled.set();return value
    monkeypatch.setattr(module,"fit_numeric_unlabeled",cancel)
    with pytest.raises(asyncio.CancelledError):execute(rt)
    assert not any(name.startswith("predictions.") for name,_ in port.calls)


def test_empty_scope_publishes_empty_complete_collection_without_fit(make_runtime):
    rt=make_runtime();port=SyntheticPort(rt,np.empty((0,3)))
    execute(rt)
    finish=next(p for name,p in port.calls if name=="predictions.finish")
    assert finish["scope_count"]==finish["returned"]==0 and finish["passed"] is True
    assert port.updates[-1]["semantic_complete"] is True
    assert rt.model.calls==0 and not port.read_counts


@pytest.mark.parametrize("method",("dual_description_margin","name_gmm","kmeans"))
def test_public_dispatch_publishes_same_numeric_collection_without_teacher(make_runtime,method):
    rt=make_runtime();port=SyntheticPort(rt,vectors())
    events=asyncio.run(collect(invoke_rows("sem_filter",rt,source([]),"synthetic explicit predicate",{
        "algorithm":method,"scope_mode":"full",
        "recall_scope_key":"synthetic-recall-scope","options":{"block_size":7,"seed":7}})))
    assert events==[] and rt.model.calls==0 and not port.read_counts
    finish=next(p for name,p in port.calls if name=="predictions.finish")
    assert finish["passed"] is True and finish["scope_count"]==24
