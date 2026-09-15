import asyncio
import json
import random
from dataclasses import asdict, replace
import pytest
from caseweave_ops import *
from caseweave_ops.planner import PLAN_SCHEMA, validate_plan
from conftest import record, source, collect, decisions


def plan():
    return {"keywords":["副卡","解绑","副卡"],"instruction":"当前需要办理解绑；排除未来自行办理和纯咨询。",
            "retrieval_expressions":["副卡解绑受阻"],"goal":{"mode":"all","count":None},
            "steps":[{"id":"s","op":"sem_search","inputs":["$source"],"instruction":"找线索","params":{}},
                     {"id":"f","op":"sem_filter","inputs":["s"],"instruction":"严格按业务要求判断","params":{}}]}


def test_first_plan_is_one_llm_call_and_no_boolean_ast(make_runtime):
    rt=make_runtime(lambda p,r:plan())
    p=asyncio.run(plan_query(rt,"找全部副卡解绑问题，先显示20条"))
    assert rt.model.calls==1 and p["goal"]=={"mode":"all","count":None}
    assert p["keywords"]==["副卡","解绑"] and "hard" not in p and "keyword_ast" not in p
    assert p["original"].endswith("先显示20条")


def test_plan_rejects_budget_and_invalid_dependencies():
    p=plan(); p["steps"][0]["params"]["max_calls"]=3
    with pytest.raises(ProtocolError): validate_plan(p)
    p=plan(); p["steps"][0]["inputs"]=["later"]
    with pytest.raises(ProtocolError): validate_plan(p)


def test_plan_target_is_not_page_size():
    p=plan(); p["goal"]["count"]=20
    with pytest.raises(ProtocolError): validate_plan(p)
    p["goal"]["mode"]="examples"
    assert validate_plan(p)["goal"]["count"]==20


def test_real_jsonl_lexical_union_and_vectors(tmp_path):
    path=tmp_path/"rows.jsonl"
    values=[record("a", "副卡咨询", (1,0)), record("b","宽带故障",(0,1)), record("c","其他业务",(-1,0))]
    path.write_text("\n".join(json.dumps(asdict(r),ensure_ascii=False) for r in values),encoding="utf-8")
    backend=JsonlBackend(path)
    assert {h.record.ref for h in asyncio.run(collect(backend.lexical(["副卡","宽带"]))) }=={"a","b"}
    assert asyncio.run(collect(backend.lexical([])))==[]
    results=asyncio.run(collect(backend.semantic([[1,0]],"synthetic-test-space",1)))
    assert [r.record.ref for r in results]==["a"]


def test_no_cross_passage_keyword_concatenation(tmp_path):
    row=replace(record(),passages=(Passage("a1","f1","副"),Passage("a2","f2","卡")))
    path=tmp_path/"rows.jsonl"; path.write_text(json.dumps(asdict(row)),encoding="utf-8")
    assert asyncio.run(collect(JsonlBackend(path).lexical(["副卡"])))==[]


def test_fast_vector_does_not_wait_for_planner(make_runtime):
    async def run():
        release=asyncio.Event()
        async def slow(p,r): await release.wait(); return plan()
        rt=make_runtime(slow)
        class E:
            identity="synthetic-test-space"
            async def embed_queries(self,texts): return [[1,0] for _ in texts]
        class B:
            async def semantic(self,*args): yield Hit(record(),"vector",1)
            async def lexical(self,words): yield Hit(record("b"),"keyword",None)
        stream=bootstrap(rt,B(),E(),"q")
        first=await asyncio.wait_for(anext(stream),2)
        assert first["type"]=="candidate" and first["channel"]=="raw_vector"
        release.set()
        rest=[x async for x in stream]
        assert sum(x["type"]=="plan" for x in rest)==1
    asyncio.run(run())


def test_search_cancel_does_not_wait_for_backend():
    async def run():
        class B:
            async def semantic(self,*args):
                await asyncio.sleep(60)
                yield Hit(record(),"vector",1)
            async def lexical(self,*args):
                if False: yield None
        scope=Scope("t",1,"s","a")
        stream=sem_search(scope,B(),[[1,0]],"id",[])
        t=asyncio.create_task(anext(stream))
        await asyncio.sleep(.01);scope.cancelled.set()
        with pytest.raises(asyncio.CancelledError): await asyncio.wait_for(t,2)
    asyncio.run(run())


@pytest.mark.parametrize("seed",[1,5,11])
def test_topk_heap_matches_independent_sort(seed):
    values=list(range(113));random.Random(seed).shuffle(values)
    calls=[0]
    async def cmp(a,b):
        calls[0]+=1
        return -1 if int(a.ref)>int(b.ref) else 1 if int(a.ref)<int(b.ref) else 0
    out=asyncio.run(sem_topk(source([record(str(v)) for v in values]),7,cmp))
    assert [int(r.ref) for r in out.records]==list(range(112,105,-1))
    assert out.examined==113 and out.algorithm_completed and calls[0]<1500


def test_topk_unknown_cannot_be_reported_exact():
    async def cmp(a,b): return None
    out=asyncio.run(sem_topk(source([record(str(v)) for v in range(4)]),2,cmp))
    assert not out.algorithm_completed and out.unresolved_pairs>0


def map_payload(p,r):
    return {"rows":[{"ref":x["ref"],"status":"ok","data":{"state":"受阻"},
        "citations":[{"ref":x["ref"],"passage_id":x["passages"][0]["id"],"quote":x["passages"][0]["text"]}],
        "field_citations":{"state":[{"ref":x["ref"],"passage_id":x["passages"][0]["id"],"quote":x["passages"][0]["text"]}]}}
        for x in p["records"]]}

SCHEMA={"type":"object","properties":{"state":{"type":"string"}},"required":["state"],"additionalProperties":False}


@pytest.mark.parametrize("op",[sem_map,sem_extract])
def test_transform_schema_and_citations(op,make_runtime):
    rt=make_runtime(map_payload)
    out=asyncio.run(collect(op(rt,source([record()]),"提取状态",SCHEMA)))
    assert out[0].status=="ok" and out[0].data["state"]=="受阻"


def test_extract_requires_field_evidence(make_runtime):
    def f(p,r):
        out=map_payload(p,r);out["rows"][0]["field_citations"]={}
        return out
    rt=make_runtime(f)
    out=asyncio.run(collect(sem_extract(rt,source([record()]),"提取状态",SCHEMA)))
    assert out[0].status=="undetermined" and out[0].data is None


def test_join_requires_both_sides_and_keeps_unknown(make_runtime):
    def f(p,r):
        values=[]
        for pair in p["pairs"]:
            citations=[]
            for side in ("left","right"):
                row=pair[side]
                citations.append({"ref":row["ref"],"passage_id":row["passages"][0]["id"],"quote":row["passages"][0]["text"]})
            values.append({"pair_id":pair["pair_id"],"label":"accept","citations":citations,"reason":"fixture"})
        return {"rows":values}
    rt=make_runtime(f)
    pairs=cartesian_pairs(source([record("l1"),record("l2")]),lambda:source([record("r")]))
    out=asyncio.run(collect(sem_join(rt,pairs,"属于同一事件")))
    assert len(out)==2 and all(o.label=="accept" and len(o.citations)==2 for o in out)


@pytest.mark.parametrize("n,fan",[(0,3),(1,3),(2,3),(3,3),(4,3),(9,3),(17,4)])
def test_aggregate_streams_all_records_and_keeps_leaf_lineage(n,fan,make_runtime):
    def f(p,r):return {"status":"ok","text":"fixture summary","source_ids":[s["id"] for s in p["sources"]]}
    rt=make_runtime(f)
    out=asyncio.run(sem_agg(rt,source([record(str(i)) for i in range(n)]),"归纳",fan_in=fan))
    assert out.leaves==n and out.complete
    assert {c.ref for c in out.citations}=={str(i) for i in range(n)}
    if n==0: assert rt.model.calls==0


def test_enriched_source_can_be_reprocessed(make_runtime):
    rt=make_runtime()
    row=record()
    more=replace(row,passages=row.passages+(Passage("later","source.raw_dialogue","后续更正",100),))
    out=asyncio.run(collect(sem_filter(rt,source([row,more]),"x",batch_size=1)))
    assert len(out)==2 and rt.model.calls==2
