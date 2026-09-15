import asyncio
import math
import random
from dataclasses import replace
import numpy as np
import pytest
from caseweave_ops import *
from caseweave_ops.feedback import unit
from conftest import record, source, collect, decisions


def test_feedback_updates_without_pretraining(make_runtime):
    rt=make_runtime()
    fb=FeedbackSet(rt.predicate_key("x"))
    score=MultiViewScorer([[1,0]],"synthetic-test-space",["解绑"],fb)
    before=score.score(record("b"))
    async def run():
        result=await judge_batch(rt,[record("a")],"x")
        fb.observe(record("a"),result[0])
    asyncio.run(run())
    after=score.score(record("b"))
    assert before.support==0 and after.support==1
    assert before.scorer_id!=after.scorer_id


def test_feedback_no_self_propagation_and_revoke(make_runtime):
    rt=make_runtime()
    row=record()
    fb=FeedbackSet(rt.predicate_key("x"))
    d=asyncio.run(judge_batch(rt,[row],"x"))[0]
    fb.observe(row,replace(d,basis="proxy"))
    assert not fb.samples
    fb.observe(row,d)
    fingerprint=fb.fingerprint
    fb.observe(row,d)
    assert len(fb.samples)==1 and fingerprint==fb.fingerprint
    fb.observe(row,replace(d,label="exclude"))
    assert fb.samples[row.ref][1]==0
    fb.observe(row,replace(d,label="undetermined"))
    assert not fb.samples


def test_feedback_rejects_other_query(make_runtime):
    rt=make_runtime()
    d=asyncio.run(judge_batch(rt,[record()],"x"))[0]
    fb=FeedbackSet("different")
    with pytest.raises(ValueError): fb.observe(record(),d)


def test_embedding_identity_and_zero_vector(make_runtime):
    rt=make_runtime()
    score=MultiViewScorer([[1,0]],"expected",[],FeedbackSet(rt.predicate_key("x")))
    with pytest.raises(ValueError): score.score(record())
    with pytest.raises(ValueError): unit([0,0])
    with pytest.raises(ValueError): unit([math.nan,1])


def test_rocchio_keeps_original_and_zero_fallback():
    assert np.allclose(rocchio([1,0],[],[]),[1,0])
    assert np.allclose(rocchio([1,0],[],[[1,0]],gamma=1),[1,0])


def test_linear_fit_is_optional_and_invalidated(make_runtime):
    pytest.importorskip("sklearn")
    rt=make_runtime()
    fb=FeedbackSet(rt.predicate_key("x"))
    base=MultiViewScorer([[1,0]],"synthetic-test-space",[],fb)
    linear=LinearFeedbackScorer(base)
    assert not linear.fit()
    for i in range(6):
        r=record(str(i),text=("本次客服解绑失败" if i<3 else "未来自行咨询办理"),vector=(1,0) if i<3 else (0,1))
        d=asyncio.run(judge_batch(rt,[r],"x"))[0]
        fb.observe(r,replace(d,label="accept" if i<3 else "exclude"))
    assert linear.fit()
    assert linear.score(record("unseen")).proxy_score is not None
    fb.revoke("0")
    assert linear.score(record("unseen")).proxy_score is None


def test_uniform_calibration_not_prefix_only():
    region=FrozenRegion.sample("p","s","exclude",[str(i) for i in range(10000)],set(),1000,.1,rng=random.Random(7))
    assert any(int(i)>200 for i in region.sample_ids)
    assert len(set(region.sample_ids))==1000


def test_no_fit_holdout_overlap_and_no_missing_labels():
    with pytest.raises(ValueError): FrozenRegion.sample("p","s","accept",["a","b"],{"a"},1,.1)
    r=FrozenRegion.sample("p","s","accept",["a","b"],set(),2,.1)
    with pytest.raises(ValueError): r.evaluate({"a":"accept"},"c")
    assert r.evaluate({"a":"accept","b":"undetermined"},"c") is None


def test_exact_hypergeometric_bound_matches_integer_enumeration():
    # Small-population exhaustive check; numerical mechanism, NOT business validation.
    for N in range(1,18):
        for n in range(1,N+1):
            for errors in range(n+1):
                possible=[]
                for M in range(errors,N-n+errors+1):
                    num=sum(math.comb(M,k)*math.comb(N-M,n-k)
                        for k in range(errors+1) if 0<=k<=M and 0<=n-k<=N-M)
                    if 20*num >= math.comb(N,n): possible.append(M)
                expected=max(possible)
                assert error_upper_bound(N,n,errors,.05)==expected


def test_gate_only_frozen_members_and_scorer(make_runtime):
    rt=make_runtime(); row=record()
    key=rt.predicate_key("x")
    region=FrozenRegion.sample(key,"fixed","accept",[row.identity],set(),1,.01)
    gate=region.evaluate({row.identity:"accept"},"test-only-calibration")
    s=Scoring(.9,.9,5,.95,.1,"fixed")
    assert gate.apply(row,s,key).basis=="proxy"
    assert gate.apply(record("other"),s,key) is None
    assert gate.apply(row,replace(s,scorer_id="changed"),key) is None


def test_no_gate_means_no_automatic_knn_labels(make_runtime):
    rt=make_runtime(); fb=FeedbackSet(rt.predicate_key("x"))
    scorer=MultiViewScorer([[1,0]],"synthetic-test-space",[],fb)
    out=asyncio.run(collect(sem_filter(rt,source([record(str(i)) for i in range(6)]),"x",scorer=scorer,feedback=fb,batch_size=2)))
    assert all(o.basis=="model" for o in out) and rt.model.calls==3
