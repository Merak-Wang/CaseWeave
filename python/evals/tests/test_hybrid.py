import json

import httpx
import numpy as np

from retrieval_agent_evals.hybrid import hybrid_candidates, run_queries
from retrieval_agent_evals.teacher import _label_one
from retrieval_agent_evals import teacher_transport


def test_hybrid_union_contains_all_literal_hits_and_threshold_vector_hits():
    rows = [
        {"ticket_id": "vector", "title": "near query", "summary": "", "body": "other"},
        {"ticket_id": "keyword", "title": "", "summary": "", "body": "special phrase"},
        {"ticket_id": "outside", "title": "unrelated", "summary": "", "body": "unrelated"},
    ]
    vectors = np.asarray([[1, 0], [0.2, 0.98], [0, 1]], dtype=np.float32)
    result = hybrid_candidates(rows, vectors, {"query": "matching query", "keywords": ["special phrase"]},
                               np.asarray([1, 0], dtype=np.float32), vector_top_k=1)
    indexed = {row["ticket_id"]: row for row in result}
    assert set(indexed) == {"vector", "keyword"}
    assert indexed["vector"]["vector_hit"] and not indexed["vector"]["keyword_hit"]
    assert indexed["keyword"]["keyword_hit"] and not indexed["keyword"]["vector_hit"]


def test_threshold_includes_boundary_without_topk_floor_or_cap():
    rows = [{"ticket_id": str(i), "title": "unrelated"} for i in range(4)]
    scores = np.asarray([.9, .8, .75, .74], dtype=np.float32)
    vectors = np.column_stack([scores, np.sqrt(1 - scores ** 2)])
    result = hybrid_candidates(rows, vectors, {"query": "matching", "keywords": []},
                               np.asarray([1, 0], dtype=np.float32), vector_top_k=1)
    assert {row["ticket_id"] for row in result} == {"0", "1", "2"}


def test_run_queries_preserves_labeling_guidance_in_teacher_prompt(tmp_path, monkeypatch):
    dataset = tmp_path / "tickets.jsonl"
    dataset.write_text('{"ticket_id":"t1","title":"工号","summary":"权限异常","body":"没有角色授权","created_at":"2026"}\n', encoding="utf-8")
    queries = tmp_path / "queries.json"
    guidance = "只包含工号业务权限异常，排除客户账号问题。"
    queries.write_text('[{"condition_id":"C01","kind":"custom_cluster","name":"员工权限","query":"工号权限异常","keywords":["工号"],"labeling_guidance":"' + guidance + '"}]', encoding="utf-8")
    docs = tmp_path / "tickets.npz"
    np.savez_compressed(docs, ticket_ids=np.asarray(["t1"]), vectors=np.asarray([[1.0, 0.0]], dtype=np.float32))
    queries_npz = tmp_path / "queries.npz"
    np.savez_compressed(queries_npz, condition_ids=np.asarray(["C01"]), vectors=np.asarray([[1.0, 0.0]], dtype=np.float32))
    queries_npz.with_suffix(".manifest.json").write_text('{"embedding":{"model":"test"}}', encoding="utf-8")
    run_queries(dataset, docs, queries, tmp_path / "conditions", query_embedding_file=queries_npz,
                vector_top_k=1, limit=1)
    manifest_path = tmp_path / "conditions" / "C01" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["labeling_guidance"] == guidance
    assert manifest["query_spec"]["labeling_guidance"] == guidance
    sent = {}

    def fake_post(request):
        sent.update(json.loads(request.content))
        return httpx.Response(200, json={
            "model": "deepseek-v4.1-flash",
            "usage": {"prompt_tokens": 10, "completion_tokens": 5},
            "choices": [{"message": {"content": '{"label":"yes","confidence":0.9}'}}],
        })

    monkeypatch.setattr("retrieval_agent_evals.teacher.request_json", lambda endpoint, headers, body, **kwargs:
        teacher_transport.request_json(endpoint, headers, body, **kwargs, http_transport=httpx.MockTransport(fake_post)))
    row = {"ticket_id": "t1", "title": "工号", "summary": "权限异常", "body": "没有角色授权"}
    _label_one(row, manifest, endpoint="https://provider.invalid/chat/completions", model="deepseek-v4.1-flash",
               api_key="test-key", session_id=None)
    assert guidance in sent["messages"][0]["content"]
