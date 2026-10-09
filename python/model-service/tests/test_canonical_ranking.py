from __future__ import annotations
from copy import deepcopy
import numpy as np
import pytest
from retrieval_agent_model_service.errors import ServiceError
from retrieval_agent_model_service.ranking import Bm25fIndex, RetrievalRankingBackend

CANONICAL = "canonical-title-abstract-v1"

def docs():
    return [
        dict(id="a", contentHash="unchanged", title="alpha", summary="abstract", body="hidden", metadata="secret"),
        dict(id="b", contentHash="same", title="alpha", summary="abstract", body="", metadata=""),
    ]

def profile():
    return dict(documentProjection=CANONICAL,
        embeddingIdentity=dict(model="synthetic", revision="v1", dimensions=2),
        embeddingInstruction="retrieve")

class Models:
    max_batch_size = 16
    def __init__(self): self.calls=[]
    def descriptors(self): return [dict(kind="embedding",loaded=True,model="synthetic",revision="v1",dimensions=2)]
    def embed_measured(self,texts,input_type,instruction,dimensions,timings,cancel,complete):
        self.calls.append((list(texts), input_type, complete))
        if complete and any(len(t)>512 for t in texts):
            raise ServiceError(413,"INPUT_TOO_LONG","synthetic tokenizer bound")
        return [[1.,0.] for _ in texts]
    def embed(self,texts,input_type,instruction,dimensions):
        return self.embed_measured(texts,input_type,instruction,dimensions,{},None,False)

def test_canonical_real_rank_ignores_body_and_requires_both_fields(tmp_path):
    backend=RetrievalRankingBackend(Models(),tmp_path)
    result=backend.rank(docs(),dict(text="hidden",mode="keyword"),dict(maxScan=10),profile())
    assert result["hits"] == []
    with pytest.raises(ServiceError):
        backend.rank([{**docs()[0],"summary":""}],dict(text="alpha",mode="keyword"),dict(maxScan=10),profile())

def test_equal_bm25_scores_have_equal_source_rank():
    hits,_=Bm25fIndex([{**d,"body":"","metadata":""} for d in docs()],{}).search("alpha",[])
    assert len(hits)==2 and hits[0]["score"] == hits[1]["score"]
    assert hits[0]["rank"] == hits[1]["rank"]

def test_fusion_dedup_best_scores_global_rank_and_order():
    k=[dict(documentId="a",score=2.,rank=99),dict(documentId="b",score=2.,rank=1)]
    d=[dict(documentId="a",score=.1,rank=1),dict(documentId="a",score=.9,rank=99),
       dict(documentId="b",score=.8,rank=2)]
    options=dict(rankConstant=60,keywordWeight=.55,vectorWeight=.45)
    expected=RetrievalRankingBackend._fusion(k,d,options)
    assert expected == RetrievalRankingBackend._fusion(k[::-1],d[::-1]+d,options)
    assert expected[0]["documentId"]=="a"
    assert expected[0]["dense_raw"] == .9
    assert [h["channels"][0]["rank"] for h in expected] == [1,1]
    assert len(expected[0]["channels"])==2 and expected[0]["fused"]==expected[0]["score"]

def test_canonical_cache_uses_actual_content_and_complete_profile(tmp_path):
    models=Models(); backend=RetrievalRankingBackend(models,tmp_path)
    backend.prepare(docs(),profile(),10)
    assert all(complete for _,_,complete in models.calls)
    assert models.calls[0][0][0]=="【标题】alpha\n【摘要】abstract"
    count=len(models.calls)
    changed=deepcopy(docs()); changed[0]["body"]="another baseline only body"
    backend.prepare(changed,profile(),10)
    assert len(models.calls)==count
    changed[0]["summary"]="new abstract"
    backend.prepare(changed,profile(),10)
    assert len(models.calls)>count
    count=len(models.calls)
    backend.prepare(changed,{**profile(),"documentProjection":"ticket-search-projection-v1"},10)
    assert len(models.calls)>count

def test_canonical_prepared_features_do_not_accept_other_projection(tmp_path):
    backend=RetrievalRankingBackend(Models(),tmp_path)
    backend.prepare(docs(),profile(),10)
    with pytest.raises(ServiceError):
        backend.read_feature_block(docs(),{**profile(),"documentProjection":"ticket-search-projection-v1"})

def test_long_canonical_input_fails_explicitly_without_truncation(tmp_path):
    backend=RetrievalRankingBackend(Models(),tmp_path)
    with pytest.raises(ServiceError) as failure:
        backend.prepare([{**docs()[0],"summary":"x"*13000}],profile(),10)
    assert failure.value.status == 413

def test_bm25_snapshot_cache_reuses_and_is_bounded_by_actual_text():
    backend=RetrievalRankingBackend(Models(),lexical_cache_size=2)
    options=dict(maxScan=10)
    q=dict(text="alpha",mode="keyword")
    backend.rank(docs(),q,options,profile())
    first=list(backend._lexical_cache.values())[0]
    backend.rank(docs(),q,options,profile())
    assert list(backend._lexical_cache.values())[0] is first
    for word in ("beta","gamma"):
        backend.rank([{**docs()[0],"title":word}],dict(text=word,mode="keyword"),options,profile())
    assert len(backend._lexical_cache)==2 and first not in backend._lexical_cache.values()


def test_channel_ties_preserve_rpc_page_rank_protocol():
    backend=RetrievalRankingBackend(Models())
    result=backend.rank(docs(),dict(text="alpha",mode="keyword"),dict(maxScan=10),profile())
    assert [hit["rank"] for hit in result["hits"]]==[1,2]
    assert [hit["channels"][0]["rank"] for hit in result["hits"]]==[1,1]

def test_actual_canonical_dense_rewrite_union_best_and_dedup_order(tmp_path):
    class Rewrites(Models):
        def embed_measured(self,texts,input_type,instruction,dimensions,timings,cancel,complete):
            self.calls.append((list(texts),input_type,complete))
            if input_type=="document": return [[1.,0.] if "alpha" in t else [0.,1.] for t in texts]
            return [[.9,float(np.sqrt(1-.9**2))] if t=="rewrite" else [.1,float(np.sqrt(1-.1**2))] for t in texts]
    models=Rewrites(); backend=RetrievalRankingBackend(models,tmp_path)
    corpus=[docs()[0],{**docs()[1],"title":"beta"}]
    p={**profile(),"denseTopK":1,"minimumDenseScore":.75}
    q=dict(text="original",semanticHints=["rewrite","original","rewrite"],mode="dense")
    result=backend.rank(corpus,q,dict(maxScan=10),p)
    assert set(h["documentId"] for h in result["hits"])=={"a","b"}
    assert next(h["dense_raw"] for h in result["hits"] if h["documentId"]=="a")==pytest.approx(.9)
    assert models.calls[-1][0]==["original","rewrite"]
    reversed_result=backend.rank(corpus,{**q,"semanticHints":["original","rewrite"]},dict(maxScan=10),p)
    assert reversed_result["hits"]==result["hits"]


def test_actual_intent_keyword_count_is_preserved_with_bounded_soft_or():
    backend = RetrievalRankingBackend(Models())
    # Real fixed-intent replies contain 12/16 words. A matching late word must
    # not disappear because a legacy fast-query bound was eight words.
    terms = [f"absent_{i}" for i in range(15)] + ["alpha"]
    q = dict(text="alpha", mode="keyword", keywordQuery=dict(terms=terms, operator="or"))
    result = backend.rank(docs(), q, dict(maxScan=10), profile())
    assert {hit["documentId"] for hit in result["hits"]} == {"a", "b"}
    with pytest.raises(ServiceError) as failure:
        backend.rank(docs(), {**q, "keywordQuery": dict(terms=["alpha"]*65, operator="or")}, dict(maxScan=10), profile())
    assert failure.value.code == "INVALID_REQUEST"
