from test_canonical_ranking import Models, docs, profile
from retrieval_agent_model_service.ranking import RetrievalRankingBackend
from retrieval_agent_model_service.errors import ServiceError
import pytest

class AnchorModels(Models):
    def embed_measured(self,texts,input_type,instruction,dimensions,timings,cancel,complete):
        result=super().embed_measured(texts,input_type,instruction,dimensions,timings,cancel,complete)
        return [[0.,1.] if "negative" in t else v for t,v in zip(texts,result)]

def test_actual_anchor_identity_independent_positive_negative_and_cache(tmp_path):
    models=AnchorModels(); backend=RetrievalRankingBackend(models,tmp_path)
    backend.prepare(docs(),profile(),10)
    count=len(models.calls)
    anchors=backend.query_anchors(["positive","negative"],profile())
    assert anchors["embedding_id"] == backend.read_feature_block([],profile())["embedding_id"]
    assert anchors["vectors"] == [[1.,0.],[0.,1.]]
    assert anchors["profileIdentity"]["projectionVersion"] == profile()["documentProjection"]
    assert models.calls[-1][1:] == ("query",True)
    assert backend.query_anchors(["positive","negative"],profile()) == anchors
    assert len(models.calls)==count+1
    with pytest.raises(ServiceError):
        backend.query_anchors(["positive","negative"],{**profile(),"documentProjection":"ticket-search-projection-v1"})

def test_actual_rpc_minimal_and_full_feature_documents_remain_compatible(tmp_path):
    backend=RetrievalRankingBackend(Models(),tmp_path);backend.prepare(docs(),profile(),10)
    minimal=[{"id":d["id"],"contentHash":d["contentHash"]} for d in docs()]
    assert backend.read_feature_block(minimal,profile()) == backend.read_feature_block(docs(),profile())
    assert backend.read_features([{**minimal[0],"contentHash":"stale"}],profile())["rows"] == []

def test_new_anchor_rpc_route_uses_real_backend_and_rejects_projection(tmp_path):
    from fastapi.testclient import TestClient
    from retrieval_agent_model_service.server import create_app
    models=AnchorModels(); backend=RetrievalRankingBackend(models,tmp_path);backend.prepare(docs(),profile(),10)
    with TestClient(create_app(models,backend)) as client:
        payload={"protocolVersion":"retrieval-agent.rag.v1","requestId":"synthetic-anchors","texts":["positive","negative"],"profile":profile()}
        response=client.post("/v1/ranking/query-anchors",json=payload)
        assert response.status_code==200
        assert response.json()["embedding_id"]==backend.read_feature_block([],profile())["embedding_id"]
        payload["profile"]={**profile(),"documentProjection":"ticket-search-projection-v1"}
        assert client.post("/v1/ranking/query-anchors",json=payload).status_code==409
